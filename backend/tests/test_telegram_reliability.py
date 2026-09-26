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


class CompleteOnceTasks(TaskStore):
    def __init__(self, db):
        super().__init__(db)
        self.model_calls = 0
        self.logical_session = None

    def submit(self, *args, **kwargs):
        task = super().submit(*args, **kwargs)
        if task['status'] == 'queued':
            self.model_calls += 1
            attempt_id = self.mark_running(task['id'])
            self.logical_session = task['session_id']
            self.complete(task['id'], {'text': 'Original result', 'session_id': self.logical_session},
                          attempt_id=attempt_id)
        return self.get(task['id'])


def task_update(**changes):
    update = {
        'update_id': 17,
        'message': {'from': {'id': 42}, 'chat': {'id': 99}, 'text': 'work once'},
    }
    if 'sender_id' in changes:
        update['message']['from']['id'] = changes['sender_id']
    if 'chat_id' in changes:
        update['message']['chat']['id'] = changes['chat_id']
    if 'text' in changes:
        update['message']['text'] = changes['text']
    if 'update_id' in changes:
        update['update_id'] = changes['update_id']
    return update


@pytest.mark.asyncio
async def test_retry_uses_original_update_after_conversation_state_advances(tmp_path):
    db = Database(tmp_path / 'db')
    tasks = CompleteOnceTasks(db)
    telegram = Telegram()
    bridge = TelegramBridge(db, tasks, telegram, 42)
    await bridge.handle_update(task_update(), request_id='telegram-17')
    assert bridge.session_for_chat(99) == tasks.logical_session
    await bridge.handle_update(task_update(), request_id='telegram-17')
    assert tasks.model_calls == 1
    assert len(tasks.list()) == 1
    assert telegram.sent == [(99, 'Original result'), (99, 'Original result')]


@pytest.mark.asyncio
@pytest.mark.parametrize('change', [
    {'text': 'different work'}, {'text': ' work once '},
    {'chat_id': 100}, {'sender_id': 7}, {'update_id': 18},
])
async def test_same_update_key_with_changed_inbound_envelope_never_reexecutes(tmp_path, change):
    db = Database(tmp_path / 'db')
    tasks = CompleteOnceTasks(db)
    telegram = Telegram()
    bridge = TelegramBridge(db, tasks, telegram, 42)
    await bridge.handle_update(task_update(), request_id='telegram-17')
    # A new authorized bridge configuration must not reinterpret an old key as
    # a request from another identity, chat, update or body.
    with db.transaction() as conn:
        conn.execute('DELETE FROM telegram_conversations')
    retry_bridge = TelegramBridge(db, tasks, telegram, change.get('sender_id', 42))
    with pytest.raises(ValueError, match='different request payload'):
        await retry_bridge.handle_update(task_update(**change), request_id='telegram-17')
    assert tasks.model_calls == 1
    assert len(tasks.list()) == 1
    assert len(tasks.all_events(0)) == 3
    assert telegram.sent == [(99, 'Original result')]
