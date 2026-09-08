import asyncio
import logging
import pytest
from archon_server.db import Database
from archon_server.tasks import TaskStore
from archon_server.services.telegram import TelegramBridge

class Telegram:
    def __init__(self): self.sent=[]
    async def send_message(self, chat_id, text): self.sent.append((chat_id,text))

@pytest.mark.asyncio
async def test_commands_do_not_submit_model_work(tmp_path):
    db=Database(tmp_path/'db');tasks=TaskStore(db);tg=Telegram();b=TelegramBridge(db,tasks,tg,42)
    b._remember_session(99,'previous-session')
    for cmd in ['/status','/help','/start','/new']:
        await b.handle_update({'message':{'from':{'id':42},'chat':{'id':99},'text':cmd}})
    assert tasks.list()==[]
    assert len(tg.sent)==4
    assert b.session_for_chat(99) is None

@pytest.mark.asyncio
async def test_deleted_session_mapping_is_not_reused(tmp_path):
    db=Database(tmp_path/'db');tasks=TaskStore(db);b=TelegramBridge(db,tasks,Telegram(),42)
    b._remember_session(99,'gone')
    tasks.prepare_session_deletion(['gone'])
    assert b.session_for_chat(99) is None

@pytest.mark.asyncio
async def test_failed_reply_retries_without_rerunning_task_or_losing_cursor(tmp_path,caplog):
    db=Database(tmp_path/'db')
    class CompletedTasks(TaskStore):
        def submit(self,*args,**kwargs):
            t=super().submit(*args,**kwargs)
            with self.db.transaction() as c:
                c.execute("UPDATE tasks SET status='completed',result_json=? WHERE id=?", ('{"text":"REPLY","session_id":"session-1"}',t['id']))
            return self.get(t['id'])
    tasks=CompletedTasks(db)
    class UnreliableTelegram(Telegram):
        def __init__(self):super().__init__();self.offsets=[];self.attempts=0
        async def get_updates(self,offset,timeout=30):
            self.offsets.append(offset)
            return [{'update_id':17,'message':{'from':{'id':42},'chat':{'id':99},'text':'work once'}}]
        async def send_message(self,chat_id,text):
            self.attempts+=1
            if self.attempts==1:
                assert b.next_update_offset()==0
                raise RuntimeError('secret_token_must_not_be_logged')
            await super().send_message(chat_id,text)
            b.stop()
    tg=UnreliableTelegram();b=TelegramBridge(db,tasks,tg,42)
    with caplog.at_level(logging.WARNING):
        await asyncio.wait_for(b.run_forever(),timeout=5)
    assert tg.offsets==[0,0]
    assert len(tasks.list())==1
    assert tasks.list()[0]['id']=='telegram-17'
    assert tg.sent==[(99,'REPLY')]
    assert b.next_update_offset()==18
    assert 'cursor retained' in caplog.text
    assert 'secret_token_must_not_be_logged' not in caplog.text

@pytest.mark.asyncio
async def test_queued_request_acknowledged_then_result_delivered(tmp_path,caplog):
    class QueuedTasks:
        def submit(self,*args,**kwargs):return {'id':'test-task','status':'queued'}
        def get(self,task_id):return {'status':'completed','result':{'text':'FINISHED','session_id':'new-session'}}
    tg=Telegram();b=TelegramBridge(Database(tmp_path/'db'),QueuedTasks(),tg,42)
    with caplog.at_level(logging.INFO):
        await b.handle_update({'message':{'from':{'id':42},'chat':{'id':99},'text':'perform secret user task'}})
    assert len(tg.sent)==2
    assert 'received your request' in tg.sent[0][1]
    assert tg.sent[1]==(99,'FINISHED')
    assert 'Telegram task reply delivered' in caplog.text
    assert 'secret user task' not in caplog.text

@pytest.mark.asyncio
async def test_unauthorized_commands_do_not_reset_conversation(tmp_path):
    db=Database(tmp_path/'db');tasks=TaskStore(db);tg=Telegram();b=TelegramBridge(db,tasks,tg,42)
    b._remember_session(99,'keep')
    await b.handle_update({'message':{'from':{'id':7},'chat':{'id':99},'text':'/new'}})
    assert b.session_for_chat(99)=='keep'
    assert tg.sent==[]
