import json
from pathlib import Path
import pytest
from archon_server.services.agent_resources import AgentResourceService


def config(tmp_path):
    for runtime in ('prime','pi'):
        (tmp_path/runtime).mkdir()
    return {r:{'agent_dir':str(tmp_path/r),'runtime_dir':str(tmp_path/(r+'-dist')),'shared_dir':str(tmp_path/'shared'),'package_roots':[]} for r in ('prime','pi')}


def test_runtime_resources_stay_separate_and_empty_is_real(tmp_path):
    def probe(runtime, spec):
        return {'skills':[{'name':'Prime only','path':str(tmp_path/'SKILL.md'),'description':'Real file','scope':'user','state':'Installed'}] if runtime=='prime' else [],'mcps':[],'warnings':[],'checked_paths':[]}
    service=AgentResourceService(config(tmp_path), probe=probe)
    result=service.inventory()
    assert len(result['agents']['prime']['skills'])==1
    assert result['agents']['pi']['skills']==[]
    assert result['agents']['pi']['mcps']==[]


def test_metadata_never_returns_mcp_secrets(tmp_path):
    def probe(runtime,spec):
        return {'skills':[],'mcps':[{'name':'local','transport':'stdio','state':'Configured','scope':'user','config_path':'settings.json','env':{'TOKEN':'SECRET_SENTINEL'},'headers':{'Authorization':'SECRET_SENTINEL'},'args':['SECRET_SENTINEL'],'url':'https://example?token=SECRET_SENTINEL'}],'warnings':[],'checked_paths':[]}
    result=AgentResourceService(config(tmp_path),probe=probe).inventory()
    assert 'SECRET_SENTINEL' not in json.dumps(result)
    assert result['agents']['pi']['mcps'][0]['name']=='local'


def test_failed_scan_is_an_error_not_fake_or_empty_success(tmp_path):
    def probe(runtime,spec):
        if runtime=='pi':raise RuntimeError('sensitive details must not escape')
        return {'skills':[],'mcps':[]}
    result=AgentResourceService(config(tmp_path),probe=probe).inventory()
    assert result['agents']['pi']['error']
    assert 'sensitive details' not in json.dumps(result)
    assert result['agents']['prime']['error'] is None


def test_inspect_requires_known_runtime_and_current_skill_id(tmp_path):
    skill=tmp_path/'SKILL.md';skill.write_text('---\nname: test\ndescription: example\n---\nReal instructions')
    def probe(runtime,spec):
        return {'skills':[{'name':'test','description':'example','path':str(skill),'scope':'user','state':'Installed'}] if runtime=='pi' else [],'mcps':[]}
    service=AgentResourceService(config(tmp_path),probe=probe)
    item=service.inventory()['agents']['pi']['skills'][0]
    assert 'Real instructions' in service.inspect('pi',item['id'])['content']
    with pytest.raises(KeyError):service.inspect('prime',item['id'])
    with pytest.raises(KeyError):service.inspect('pi','../../etc/passwd')
    with pytest.raises(ValueError):service.inspect('other',item['id'])
