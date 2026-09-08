from test_pi_history import history


def test_mixed_batch_deletes_prime_and_native_pi(history):
    c,native,text,tmp=history
    r=c.request('DELETE','/api/sessions',json={'session_ids':['same-id','pi-native-same-id']})
    assert r.status_code==200,r.text
    assert not native.exists()
    assert not (tmp/'prime'/'renamed.jsonl').exists()
    assert len(list((tmp/'data'/'deleted-native-pi').glob('*.jsonl')))==1


def test_running_batch_does_not_archive_native_pi(history):
    c,native,text,tmp=history
    r=c.post('/api/tasks',json={'prompt':'fixture only','session_id':'same-id','cwd':str(tmp)})
    assert r.status_code==202,r.text
    r=c.request('DELETE','/api/sessions',json={'session_ids':['same-id','pi-native-same-id']})
    assert r.status_code==409,r.text
    assert native.read_text()==text
    assert not list((tmp/'data'/'deleted-native-pi').glob('*.jsonl'))
