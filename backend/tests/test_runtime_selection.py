import pytest
from fastapi.testclient import TestClient
from archon_server.app import create_app
from archon_server.config import Settings

@pytest.mark.parametrize('owner,other', [('pi', None),(None,'pi')])
def test_reply_stays_with_session_runtime(tmp_path,owner,other):
    settings=Settings(archon_root=tmp_path,hermes_home=tmp_path/'.hermes',data_dir=tmp_path/'.data',auth_token='test',start_worker=False,profile='archon')
    with TestClient(create_app(settings)) as c:
        headers={'Authorization':'Bearer test'}
        first=c.post('/api/tasks',headers=headers,json={'prompt':'first','profile':owner,'cwd':str(tmp_path)}).json()['task']
        sid=first['session_id']
        reply=c.post('/api/tasks',headers=headers,json={'prompt':'reply','session_id':sid,'profile':other})
        assert reply.status_code==202,reply.text
        assert reply.json()['task']['profile']==first['profile']
        rows=c.get('/api/sessions',headers=headers).json()['sessions']
        assert next(s for s in rows if s['id']==sid)['runtime']==('pi' if owner else 'prime')
