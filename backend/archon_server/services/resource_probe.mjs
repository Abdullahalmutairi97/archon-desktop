// Read-only global resource discovery. Never loads extensions, starts MCP servers,
// executes package managers, or reads credential files.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const spec=JSON.parse(fs.readFileSync(0,'utf8'));
const runtime=spec.runtime, agentDir=spec.agent_dir, dist=spec.runtime_dir;
const warnings=[],checked=new Set(),skills=[],mcps=[];
const req=createRequire(path.join(dist,'core','package-manager.js'));
const native=await import(pathToFileURL(path.join(dist,'core','skills.js')).href);
let globSync,match;
try{const glob=req('glob'),minimatch=req('minimatch');globSync=glob.globSync||glob.sync;match=minimatch.minimatch||minimatch}catch{}
const hasGlob=p=>/[*?{}\[\]]/.test(p);
function pathsFor(p){if(globSync)return globSync(p,{nodir:false});if(hasGlob(p)){warnings.push('Glob support is unavailable; a resource pattern could not be expanded.');return []}return [p]}
function readJson(file){checked.add(file);if(!fs.existsSync(file))return {};try{const value=JSON.parse(fs.readFileSync(file,'utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{warnings.push('A resource settings file could not be parsed.');return {}}}
const settingsPath=path.join(agentDir,'settings.json'),settings=readJson(settingsPath);
function expand(p,base=agentDir){if(p==='~'||p.startsWith('~/'))return path.resolve(spec.home,p.slice(2));return path.resolve(base,p)}
const roots=[{dir:spec.user_skills_dir||path.join(agentDir,'skills'),scope:'user',rootFiles:true},{dir:spec.shared_dir,scope:'shared',rootFiles:false}];
const patterns=Array.isArray(settings.skills)?settings.skills.filter(x=>typeof x==='string'):[];
if(!match&&patterns.some(p=>['!','-','+'].includes(p[0])&&hasGlob(p)))warnings.push('Pattern exclusions could not be evaluated by this runtime installation.');
for(const raw of patterns){if(raw.startsWith('!')||raw.startsWith('-'))continue;const value=raw.startsWith('+')?raw.slice(1):raw,p=expand(value);const paths=pathsFor(p);for(const dir of paths)roots.push({dir,scope:'settings',rootFiles:true})}
for(const entry of Array.isArray(settings.packages)?settings.packages:[]){
 const source=typeof entry==='string'?entry:entry?.source;if(typeof source!=='string')continue;
 let packageRoot;
 if(source.startsWith('.')||source.startsWith('/')||source.startsWith('~'))packageRoot=expand(source);
 else if(!source.includes('://')&&!source.startsWith('git:')){
  let name=source.replace(/^npm:/,'');const at=name.lastIndexOf('@');if(at>0)name=name.slice(0,at);
  if(!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)){warnings.push('An installed package source could not be resolved.');continue}
  packageRoot=(spec.package_roots||[]).map(p=>path.join(p,name)).find(p=>fs.existsSync(path.join(p,'package.json')));
 }
 if(!packageRoot||!fs.existsSync(packageRoot)){warnings.push('A configured package was not found locally; nothing was installed automatically.');continue}
 const manifest=readJson(path.join(packageRoot,'package.json'));const declarations=Array.isArray(manifest.pi?.skills)?manifest.pi.skills:['skills'];
 if(typeof entry==='object'&&Array.isArray(entry.skills)&&entry.skills.length===0)continue;
 if(typeof entry==='object'&&Array.isArray(entry.skills)&&entry.skills.length)warnings.push('Package-specific skill filters may further limit this installed inventory.');
 for(const declared of declarations){if(typeof declared!=='string')continue;const p=path.resolve(packageRoot,declared);for(const dir of pathsFor(p))roots.push({dir,scope:'package',rootFiles:true})}
}
const builtin=spec.builtin_skills_dir||path.join(dist,'skills');if(runtime==='prime')roots.push({dir:builtin,scope:'builtin',rootFiles:true});
const seen=new Set(),names=new Set();
for(const root of roots){checked.add(root.dir);if(!fs.existsSync(root.dir))continue;
 try{
  const stat=fs.statSync(root.dir);let found=[];
  if(stat.isFile()&&root.dir.endsWith('.md'))found=native.loadSkills({cwd:agentDir,agentDir,skillPaths:[root.dir],includeDefaults:false}).skills;
  else if(stat.isDirectory()){
   const dirs=root.rootFiles?[root.dir]:fs.readdirSync(root.dir).filter(n=>!n.startsWith('.')).map(n=>path.join(root.dir,n)).filter(p=>{try{return fs.statSync(p).isDirectory()}catch{return false}});
   for(const dir of dirs)found.push(...native.loadSkillsFromDir({dir,source:root.scope}).skills);
  }
  for(const skill of found){
   const real=fs.realpathSync(skill.filePath);if(seen.has(real))continue;seen.add(real);
   let state='Installed';
   if(root.scope==='builtin'&&(settings.enableBuiltinSkills===false||(skill.name==='websearch'&&settings.bundledSkills?.websearch===false)))state='Disabled in settings';
   for(const raw of patterns){
    const prefix=raw[0];if(!['!','-','+'].includes(prefix))continue;
    const pattern=raw.slice(1),relative=path.relative(root.dir,skill.filePath).replaceAll(path.sep,'/');
    const matches=match?[real,skill.filePath,relative,path.basename(path.dirname(real))+'/SKILL.md'].some(v=>match(v,pattern,{dot:true}))||match(real,expand(pattern),{dot:true}):[real,skill.filePath,relative,path.basename(path.dirname(real))+'/SKILL.md'].includes(pattern)||real===expand(pattern);
    if(matches)state=prefix==='+'?'Installed':'Excluded in settings';
   }
   if(names.has(skill.name))state='Duplicate name';names.add(skill.name);
   skills.push({name:String(skill.name),description:String(skill.description||''),path:skill.filePath,scope:root.scope,state,kind:skill.kind||'markdown',manual_only:!!skill.disableModelInvocation});
  }
 }catch{warnings.push('A skill location could not be inspected.')}
}
function serverRows(servers,configPath){
 if(!servers||typeof servers!=='object'||Array.isArray(servers))return;
 for(const [name,config] of Object.entries(servers)){
  if(!/^[a-z0-9][a-z0-9_.-]{0,100}$/i.test(name)||!config||typeof config!=='object')continue;
  const transport=config.type==='stdio'||config.command?'stdio':config.type==='sse'?'sse':'http';
  const existing=mcps.find(m=>m.name===name);
  const item={name,label:name,transport,scope:'user',state:config.enabled===false||config.disabled===true?'Disabled':'Configured',config_path:configPath,auth_checked:false};
  if(existing?.scope==='builtin'){item.state='Reserved name conflict';item.note='Prime reserves built-in integration names. Use a different name for a custom server.';mcps.splice(mcps.indexOf(existing),1)}
  else if(existing)continue;
  mcps.push(item);
 }
}
if(runtime==='prime'){
 try{const catalog=(req.resolve.paths('@earendil-works/pi-ai')||[]).map(p=>path.join(p,'@earendil-works/pi-ai/dist/mcp/catalog.js')).find(p=>fs.existsSync(p));if(!catalog)throw Error('Catalog unavailable');const {BUILTIN_MCP_CATALOG}=await import(pathToFileURL(catalog).href);
  for(const entry of BUILTIN_MCP_CATALOG)mcps.push({name:entry.server,label:entry.label,transport:'http',scope:'builtin',state:'Built-in',config_path:'Installed Prime MCP catalog',auth_checked:false,note:'Authentication is managed in Prime. Connection status has not been tested.'});
 }catch{warnings.push('The installed Prime MCP catalog could not be read.')}
 serverRows(settings.mcpServers,settingsPath);
}else{
 serverRows(settings.mcpServers,settingsPath);
 for(const p of spec.mcp_config_paths||[]) {const config=readJson(p);serverRows(config.mcpServers||config.servers,p)}
 if(mcps.length)warnings.push('Pi MCP entries require a matching MCP extension. Configuration is shown; activation is not verified.');
}
process.stdout.write(JSON.stringify({skills,mcps,warnings:[...new Set(warnings)],checked_paths:[...checked],scope:'global'}));
