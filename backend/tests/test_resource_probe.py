import json
import shutil
import subprocess
from pathlib import Path
import pytest

PROBE=Path(__file__).parents[1]/'archon_server/services/resource_probe.mjs'

@pytest.fixture
def fixture_spec(tmp_path):
    dist=tmp_path/'dist';(dist/'core').mkdir(parents=True)
    (dist/'package.json').write_text('{"type":"module"}')
    (dist/'core/skills.js').write_text('''import fs from 'node:fs';import path from 'node:path';
export function loadSkillsFromDir({dir}) {let skills=[];for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);if(fs.statSync(p).isDirectory())skills.push(...loadSkillsFromDir({dir:p}).skills);else if(name.endsWith('.md')){const body=fs.readFileSync(p,'utf8'),name=body.match(/^name: (.+)$/m)?.[1],description=body.match(/^description: (.+)$/m)?.[1];if(name&&description)skills.push({name,description,filePath:p})}}return {skills}}
export function loadSkills(){return {skills:[]}}''')
    catalog=dist/'node_modules/@earendil-works/pi-ai/dist/mcp';catalog.mkdir(parents=True)
    (catalog.parent.parent/'package.json').write_text('{"type":"module"}')
    (catalog/'catalog.js').write_text('export const BUILTIN_MCP_CATALOG=[{server:"linear",label:"Linear"},{server:"notion",label:"Notion"}];')
    agent=tmp_path/'agent';agent.mkdir()
    return {'runtime':'prime','home':str(tmp_path),'agent_dir':str(agent),'runtime_dir':str(dist),'shared_dir':str(tmp_path/'shared'),'package_roots':[],'mcp_config_paths':[str(agent/'mcp.json')]}


def run(spec):
    if not shutil.which('node'):pytest.skip('node required for native resource probe')
    result=subprocess.run(['node',str(PROBE)],input=json.dumps(spec),text=True,capture_output=True,check=True,timeout=15)
    return json.loads(result.stdout)


def skill(path,name):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(f'---\nname: {name}\ndescription: fixture description\n---\nBody')


def test_real_files_and_builtin_catalog_not_catalog_placeholders(fixture_spec):
    s=fixture_spec
    skill(Path(s['agent_dir'])/'skills/nested/test/SKILL.md','user-test')
    skill(Path(s['runtime_dir'])/'skills/builtin/SKILL.md','bundled-test')
    d=run(s)
    assert {x['name'] for x in d['skills']}=={'user-test','bundled-test'}
    assert {x['name'] for x in d['mcps']}=={'linear','notion'}
    assert all(x['state']=='Built-in' and not x['auth_checked'] for x in d['mcps'])
    d=run({**s,'runtime':'pi'})
    assert [x['name'] for x in d['skills']]==['user-test']
    assert d['mcps']==[]
    assert d['warnings']==[]  # No patterns means no glob dependency is needed.


def test_secrets_and_extensions_are_not_exposed_or_executed(fixture_spec):
    s=fixture_spec;agent=Path(s['agent_dir']);marker=agent/'EXECUTED'
    extension=agent/'extension.mjs';extension.write_text(f"import fs from 'node:fs';fs.writeFileSync({json.dumps(str(marker))},'bad');")
    (agent/'auth.json').write_text('{"private":"SECRET_SENTINEL"}')
    (agent/'settings.json').write_text(json.dumps({'extensions':[str(extension)],'mcpServers':{'local':{'command':'dangerous-command','args':['SECRET_SENTINEL'],'env':{'TOKEN':'SECRET_SENTINEL'},'headers':{'Authorization':'SECRET_SENTINEL'},'url':'https://example?token=SECRET_SENTINEL'}}}))
    d=run(s)
    assert 'SECRET_SENTINEL' not in json.dumps(d)
    assert 'dangerous-command' not in json.dumps(d)
    assert not marker.exists()
    assert next(x for x in d['mcps'] if x['name']=='local')['state']=='Configured'


def test_settings_disable_is_not_reported_enabled_and_pi_config_is_separate(fixture_spec):
    s=fixture_spec;agent=Path(s['agent_dir'])
    skill(Path(s['runtime_dir'])/'skills/builtin/SKILL.md','builtin')
    (agent/'settings.json').write_text('{"enableBuiltinSkills":false}')
    (agent/'mcp.json').write_text('{"mcpServers":{"pi-only":{"command":"never-run","disabled":true}}}')
    d=run(s)
    assert d['skills'][0]['state']=='Disabled in settings'
    assert not any(x['name']=='pi-only' for x in d['mcps'])
    d=run({**s,'runtime':'pi'})
    assert d['skills']==[]
    assert d['mcps'][0]['name']=='pi-only' and d['mcps'][0]['state']=='Disabled'


def test_missing_runtime_is_failure_not_fabricated_success(fixture_spec):
    with pytest.raises(subprocess.CalledProcessError):run({**fixture_spec,'runtime_dir':fixture_spec['agent_dir']})
