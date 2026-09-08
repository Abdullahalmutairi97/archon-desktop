from fastapi.testclient import TestClient
from archon_server.app import create_app
from archon_server.config import Settings
from archon_server.services.agent_resources import AgentResourceService


def test_resource_routes_are_authenticated_read_only_and_runtime_scoped(tmp_path,monkeypatch):
    skill=tmp_path/'SKILL.md';skill.write_text('---\nname: fixture\ndescription: example\n---\nFixture instructions')
    def probe(self,runtime,spec):
        return {'skills':[{'name':'fixture','description':'example','path':str(skill),'scope':'user','state':'Installed'}] if runtime=='pi' else [],'mcps':[]}
    monkeypatch.setattr(AgentResourceService,'_probe',probe)
    settings=Settings(archon_root=tmp_path,hermes_home=tmp_path/'hermes',data_dir=tmp_path/'data',prime_agent_session_dir=tmp_path/'prime',prime_agent_artifact_dir=tmp_path/'artifacts',prime_executable=tmp_path/'no-prime',auth_token='test',start_worker=False,resource_home=tmp_path)
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/agent-resources').status_code==401
        client.headers['Authorization']='Bearer test'
        data=client.get('/api/agent-resources').json()
        assert data['agents']['prime']['skills']==[]
        row=data['agents']['pi']['skills'][0]
        assert client.get(f"/api/agent-resources/pi/skills/{row['id']}").json()['content'].endswith('Fixture instructions')
        assert client.get(f"/api/agent-resources/prime/skills/{row['id']}").status_code==404
        assert client.get('/api/agent-resources/invalid/skills/id').status_code==400
        assert client.put('/api/agent-resources',json={}).status_code==405
        assert skill.exists()
