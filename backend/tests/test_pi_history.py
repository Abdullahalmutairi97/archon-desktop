import json
import pytest
from fastapi.testclient import TestClient
from archon_server.app import create_app
from archon_server.config import Settings

@pytest.fixture
def history(tmp_path):
    prime=tmp_path/'prime'; pi=tmp_path/'pi'/'--project--'
    prime.mkdir(); pi.mkdir(parents=True)
    records=[{'type':'session','version':3,'id':'same-id','timestamp':'2026-01-01T12:00:00Z','cwd':str(tmp_path)}, {'type':'model_change','id':'model','parentId':None,'modelId':'gpt-6-astra','timestamp':'2026-01-01T12:00:01Z'}, {'type':'message','id':'user','parentId':'model','timestamp':'2026-01-01T12:00:02Z','message':{'role':'user','content':'history fixture'}}, {'type':'message','id':'answer','parentId':'user','timestamp':'2026-01-01T12:00:03Z','message':{'role':'assistant','content':[{'type':'text','text':'saved answer'}]}}]
    text='\n'.join(map(json.dumps,records))+'\n'
    native=pi/'timestamp_uuid.jsonl'; native.write_text(text)
    (prime/'renamed.jsonl').write_text(text)
    settings=Settings(archon_root=tmp_path,hermes_home=tmp_path/'hermes',data_dir=tmp_path/'data',prime_agent_session_dir=prime,prime_agent_artifact_dir=tmp_path/'artifacts',pi_agent_session_dir=pi.parent,prime_executable=tmp_path/'no-prime',auth_token='test',start_worker=False)
    with TestClient(create_app(settings)) as client:
        client.headers['Authorization']='Bearer test'
        yield client,native,text,tmp_path

def test_both_native_histories_are_namespaced_and_labelled(history):
    c,_,_,_=history
    rows={s['id']:s for s in c.get('/api/sessions').json()['sessions']}
    assert rows['same-id']['runtime']=='prime'
    pi=rows['pi-native-same-id']
    assert pi['runtime']=='pi' and pi['source']=='pi-cli' and pi['read_only']
    assert pi['model']=='gpt-6-astra' and pi['message_count']==2
    messages=c.get('/api/sessions/pi-native-same-id/messages').json()['messages']
    assert [m['content'] for m in messages]==['history fixture','saved answer']

def test_native_history_still_cannot_be_resumed(history):
    c,native,text,tmp=history
    assert c.post('/api/tasks',json={'prompt':'do not run','session_id':'pi-native-same-id','profile':'pi','cwd':str(tmp)}).status_code==409
    assert native.read_text()==text
    assert c.get('/api/tasks').json()['tasks']==[]

@pytest.mark.parametrize('batch', [False, True])
def test_native_history_can_be_deleted_with_recovery_copy(history, batch):
    c,native,text,tmp=history
    if batch:
        response=c.request('DELETE','/api/sessions',json={'session_ids':['pi-native-same-id']})
    else:
        response=c.delete('/api/sessions/pi-native-same-id')
    assert response.status_code==200, response.text
    assert not native.exists()
    copies=list((tmp/'data'/'deleted-native-pi').rglob('*.jsonl'))
    assert len(copies)==1 and copies[0].read_text()==text
    assert (tmp/'prime'/'renamed.jsonl').exists()
    assert not any(s['id']=='pi-native-same-id' for s in c.get('/api/sessions').json()['sessions'])
    assert c.delete('/api/sessions/pi-native-same-id').status_code==404


def test_recovery_failure_keeps_native_history_visible(history, monkeypatch):
    c,native,text,tmp=history
    import shutil
    def fail(*args, **kwargs):
        raise OSError('fixture archive failure')
    monkeypatch.setattr(shutil, 'move', fail)
    response=c.delete('/api/sessions/pi-native-same-id')
    assert response.status_code==503
    assert native.read_text()==text
    assert any(s['id']=='pi-native-same-id' for s in c.get('/api/sessions').json()['sessions'])

def test_discovery_refreshes_and_does_not_follow_external_symlinks(history):
    c,native,_,tmp=history
    outside=tmp/'outside.jsonl'; outside.write_text(json.dumps({'type':'session','id':'outside'})+'\n')
    (native.parent/'escape.jsonl').symlink_to(outside)
    assert not any(s['id']=='pi-native-outside' for s in c.get('/api/sessions').json()['sessions'])
    native.unlink()
    assert not any(s['id'].startswith('pi-native-') for s in c.get('/api/sessions').json()['sessions'])
