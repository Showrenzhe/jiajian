'use strict';

function createSubprojects({ shots, serialize, revive,voiceIO }) {
  let main = new WeakMap();
  let projects = [];
  let active = null;
  let categories = new WeakMap();
  let mainVoice;
  const keyVoice=(state={})=>({whole:state.whole,segments:new WeakMap((state.segments??[]).map(({index,items})=>[shots[index],items]))});
  const packVoice=(state)=>state && ({...(state.whole && {whole:state.whole}),segments:shots.flatMap((s,index)=>state.segments.has(s)?[{index,items:state.segments.get(s)}]:[])});
  const same = typeof module === 'object' && module.exports ? require('./edit-history.js').sameEditSnapshot : window.sameEditSnapshot;
  const { pinCandidateLanes } = typeof module === 'object' && module.exports ? require('./track-tools.js') : window;
  const hasVoice=(items)=>items?.some((item)=>item?.id || item?.srt);
  function ownRows(current,base,trimWhole) {
    if(same(current,base)||(!hasVoice(current)&&hasVoice(base)))return;
    if(!hasVoice(current))return current?.length?current:undefined;
    const newIds=current.filter((item)=>item?.id && !base?.some((r)=>r?.id===item.id));
    if(newIds.length && trimWhole) return current.filter((item)=>item && !base?.some((r)=>r?.id && r.id===item.id));
    if(newIds.length) return current.map((item)=>base?.some((r)=>r?.id && r.id===item?.id)?null:item);
    return current;
  }
  function captureVoice() {
    if(!active||!voiceIO)return;
    const visible=voiceIO.read();
    mainVoice??=keyVoice(visible);
    const segments=[];
    for(const row of visible.segments) {
      const own=ownRows(row.items,mainVoice.segments.get(shots[row.index]),false);
      if(own)segments.push({index:row.index,items:own});
    }
    active.localVoice=keyVoice({whole:ownRows(visible.whole,mainVoice.whole,true),segments});
  }
  function showVoice() {
    if(!voiceIO||!mainVoice)return;
    const own=active?.localVoice;
    voiceIO.write({whole:own?.whole ?? mainVoice.whole ?? [],segments:shots.map((shot,index)=>({index,items:own?.segments.get(shot)??mainVoice.segments.get(shot)??[]}))});
  }
  function syncVoices() {
    if(!active || !voiceIO || !mainVoice)return;
    const before=voiceIO.read();captureVoice();
    const own=active.localVoice,whole=own.whole??mainVoice.whole??[];
    if(!same(whole,before.whole) || before.segments.some((row)=>!same(row.items,own.segments.get(shots[row.index])??mainVoice.segments.get(shots[row.index])??[])))showVoice();
  }
  function reorderVoiceFollows(previousShots) {
    if (!projects.length) return;
    const positions = new Map(shots.map((shot,index) => [shot,index]));
    for (const voice of [mainVoice, ...projects.map((project) => project.localVoice)]) {
      if (voice?.whole) voice.whole = voice.whole.map((track) => Number.isInteger(track?.follow)
        ? {...track, follow:positions.get(previousShots[track.follow])} : track);
    }
  }
  const snapshot = (shot) => structuredClone(shot.map(serialize));
  function replace(shot, clips) { shot.splice(0, shot.length, ...clips.map((row) => revive(row))); }

  function capture() {
    if (!active) return;
    for (const shot of shots) {
      const base = main.get(shot) ?? [];
      const clips = snapshot(shot);
      if (clips.length) active.emptyShots?.delete(shot);
      if ((clips.length && !same(clips, base)) || active.emptyShots?.has(shot)) active.shots.set(shot, clips);
      else active.shots.delete(shot);
    }
  }
  function select(id) {
    const next = id === null ? null : projects.find((project) => project.id === id);
    if (next === undefined || next === active) return;
    capture();
    if(voiceIO) { if(active)captureVoice();else mainVoice=keyVoice(voiceIO.read()); }
    if (!active) main = new WeakMap(shots.map((shot) => [shot, snapshot(shot)]));
    active = next;
    for (const shot of shots) replace(shot, active?.shots.get(shot) ?? main.get(shot) ?? []);
    showVoice();
  }
  function create(name) {
    const names=name.split(/\r?\n/).map((v)=>v.trim()).filter(Boolean);
    if (!names.length || names.some((n)=>n.length>80 || projects.some((p)=>p.name===n)) || new Set(names).size!==names.length) {
      throw new Error('请输入不重复的子工程名称，最多 80 字。');
    }
    if(names.length>500 || projects.length+names.length>1000)throw new Error('单次最多创建 500 个子工程，累计最多 1000 个。');
    const added=names.map((n)=>({id:crypto.randomUUID(),name:n,shots:new WeakMap()}));
    projects.push(...added);select(added[0].id);
  }
  function fill(assignments, mapping) {
    capture();
    if (!active) main = new WeakMap(shots.map((shot) => [shot,snapshot(shot)]));
    for(const [shot,category] of mapping) categories.set(shot,category);
    for (const {project,shot,clips} of assignments) (project?.shots ?? main).set(shot,snapshot(clips));
    for (const shot of shots) replace(shot,active?.shots.get(shot) ?? main.get(shot) ?? []);
  }
  function revert(shot) {
    if (!active || !shot) return;
    active.shots.delete(shot);
    active.emptyShots?.delete(shot);
    replace(shot, main.get(shot) ?? []);
  }
  function applyFallbacks() {
    if (active) for (const shot of shots) if (!shot.length && !active.emptyShots?.has(shot) && main.get(shot)?.length) revert(shot);
  }
  function removeCandidate(shot, clip) {
    const index=shot.indexOf(clip);
    if(index<0) return;
    // Preserve the other physical slots when removing a clip from a manually arranged shot.
    if (shot.some(item => item.videoLane !== undefined) && shot.some(item => item.videoLane === undefined)) pinCandidateLanes(shot);
    shot.splice(index,1);
    if (active && !shot.length && main.get(shot)?.length) {
      active.emptyShots ??= new WeakSet();
      active.emptyShots.add(shot);
    }
  }
  function removeMaterialReferences(ids) {
    for (const shot of shots) for (const clip of [...shot]) if (ids.has((clip.sourceEdit?.asset ?? clip.asset).id)) removeCandidate(shot,clip);
  }
  function pack() {
    if (!projects.length) return undefined;
    capture();
    const rows = (project) => shots.flatMap((shot, index) => project.shots.has(shot)
      ? [{ index, clips: project.shots.get(shot), ...(project.emptyShots?.has(shot) && !project.shots.get(shot).length && {empty:true}) }] : []);
    const mainRows = active ? shots.flatMap((shot, index) =>
      active.shots.has(shot) ? [{ index, clips: main.get(shot) ?? [] }] : []) : [];
    const links=shots.flatMap((s,index)=>categories.get(s)?[{index,category:categories.get(s)}]:[]);
    captureVoice();
    return { active: active?.id ?? null, main: mainRows, ...(active && mainVoice && {mainVoice:packVoice(mainVoice)}), ...(links.length && {categories:links}), projects: projects.map((project) => ({
      id: project.id, name: project.name, shots: rows(project),
      ...(project.variables?.length && {variables:project.variables}),
      ...(project.scriptOverride && {scriptOverride:project.scriptOverride}),
      ...(project.localVoice && {voice:packVoice(project.localVoice)}),
      ...(project.participates !== undefined && { participates: project.participates }), ...(project.count !== undefined && { count: project.count }),
    })) };
  }
  function restore(data) {
    const keyed = (rows) => new WeakMap((rows ?? []).map(({ index, clips }) => [shots[index], structuredClone(clips)]));
    projects = (data?.projects ?? []).map((project) => ({ ...project, shots: keyed(project.shots),
      emptyShots:new WeakSet(project.shots.filter((row)=>row.empty).map((row)=>shots[row.index])),localVoice:project.voice && keyVoice(project.voice) }));
    active = projects.find((project) => project.id === data?.active) ?? null;
    main = keyed(data?.main);
    mainVoice=data?.mainVoice && keyVoice(data.mainVoice);
    categories=new WeakMap((data?.categories??[]).map(({index,category})=>[shots[index],category]));
    if (active) for (const shot of shots) if (!main.has(shot)) main.set(shot, snapshot(shot));
  }
  return { select, create, revert, applyFallbacks, removeCandidate, removeMaterialReferences, pack, restore, fill, syncVoices, reorderVoiceFollows, category:(shot)=>categories.get(shot),
    inheritsVoice(shot) { return Boolean(active && (shot ? !active.localVoice?.segments.has(shot) : !active.localVoice?.whole)); },
    get projects() { return projects; }, get active() { return active; },
    ready(project) {
      return shots.length > 0 && shots.every((shot) => {
        const clips = project.shots.get(shot) ?? (active ? main.get(shot) : shot);
        return clips?.some((clip) => clip.enabled !== false);
      });
    },
    overridden(shot) { return Boolean(active?.shots.has(shot)); } };
}

if (typeof module === 'object' && module.exports) module.exports = { createSubprojects };
else window.createSubprojects = createSubprojects;

if(typeof window!=='undefined') window.mountSubprojectFill=function(ctx) {
  const el=(s)=>document.getElementById('subproject-fill'+s), modal=el('-dialog'),status=el('-status'),apply=el('-apply');
  let pools=[], mappings=[], names=[];
  function selection() {
    return pools.filter((p)=>p.check.checked).flatMap((pool)=>mappings.flatMap(({shot,select})=>{
      const category=pool.categories.get(select.value);
      return select.value && category?.length?[{project:pool.project,shot,files:category}]:[];
    }));
  }
  function summary() {
    const chosen=selection(),count=chosen.reduce((n,r)=>n+r.files.length,0);
    const overflow=chosen.find((r)=>r.files.length>ctx.maxCandidates);
    apply.disabled=!count || !!overflow;
    status.textContent=overflow ? '单个分类有 '+overflow.files.length+' 项，超过每个分镜的 '+ctx.maxCandidates+' 个候选上限。' :
      chosen.length+' 组分镜将替换为分类素材，共 '+count+' 条候选。无对应文件的分镜保留当前内容。';
  }
  function lock(value) {
    for(const control of modal.querySelectorAll('button,input,select'))control.disabled=value;
    if(!value) summary();
  }
  el('').onclick=()=>{
    if(ctx.busy())return;
    pools=[];mappings=[];names=[];el('-projects').replaceChildren();el('-mapping').replaceChildren();
    el('-path').textContent='';status.textContent='';apply.disabled=true;modal.showModal();
  };
  el('-close').onclick=()=>modal.close();modal.oncancel=(e)=>{if(ctx.busy())e.preventDefault();};
  el('-folder').onclick=async()=>{
    if(ctx.busy())return;
    ctx.begin(true);lock(true);
    let message='';
    try{
      const root=await ctx.api.pickMaterialFolder();
      if(!root)return;
      pools=[];mappings=[];names=[];el('-projects').replaceChildren();el('-mapping').replaceChildren();
      el('-path').textContent=root.name;
      for(const folder of root.folders) {
        const project=ctx.subprojects.projects.find((p)=>p.name===folder.name);
        if(!project && folder.name!=='公共素材')continue;
        const group=await ctx.api.browseMaterialFolder(folder.id),categories=new Map();
        for(const category of group.folders) {
          const items=await ctx.api.browseMaterialFolder(category.id);
          if(items.warnings?.length)throw new Error('分类「'+category.name+'」素材超过文件夹读取上限。');
          categories.set(category.name,items.files);
        }
        const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=true;
        check.onchange=summary;label.append(check,folder.name);el('-projects').append(label);
        pools.push({project,categories,check});
      }
      names=[...new Set(pools.flatMap((p)=>[...p.categories.keys()]))].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
      ctx.shots.forEach((shot,i)=>{
        const title=ctx.shotName(shot,i),label=document.createElement('label'),select=document.createElement('select');
        select.append(new Option('跳过此分镜',''),...names.map(n=>new Option(n,n)));
        const category=ctx.subprojects.category(shot) ?? title;
        if(names.includes(category))select.value=category;
        label.className='line-field';label.append(title,select);select.onchange=summary;el('-mapping').append(label);mappings.push({shot,select});
      });
      if(!pools.length) message='未找到与子工程同名的门店文件夹或「公共素材」文件夹。';
    }catch(e){pools=[];message=e.message;}
    finally{ctx.begin(false);lock(false);if(message)status.textContent=message;}
  };
  apply.onclick=async()=>{
    if(ctx.busy() || !selection().length)return;
    ctx.begin(true);lock(true);let message='';
    try{
      const updates=[], loaded=new Map();
      for(const {project,shot,files} of selection()){
        const assets=[];
        for(const file of files){
          if(!loaded.has(file.id))loaded.set(file.id,await ctx.api.loadMaterialFile(file.id));
          assets.push(loaded.get(file.id));
        }
        updates.push({project,shot,assets});
      }
      ctx.apply(updates,mappings.map(({shot,select})=>[shot,select.value]));
      modal.close();
    }catch(e){message=e.message;}
    finally{ctx.begin(false);lock(false);if(message)status.textContent=message;}
  };
};
