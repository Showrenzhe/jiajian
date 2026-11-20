'use strict';
const {normalizeSubtitles}=require('./subtitles.cjs');
const {audioSpeed, normalizeSegmentVoiceCuts}=require('./shot-timing.cjs');

function normalizeVoice(value,count,ref) {
  if(!value || typeof value!=='object')throw new Error('子工程口播无效。');
  function tracks(rows,whole) {
    if(!Array.isArray(rows)||rows.length>250)throw new Error('子工程口播轨数量无效。');
    return rows.map((row,i)=>{
      if(row==null)return null;
      const id=row.id==null?null:ref(row.id);
      if(!id && !whole)throw new Error('分段口播缺少素材。');
      const v={id};
      if(row.caption!==undefined) {
        if(typeof row.caption==='string' && row.caption.length<=500) v.caption=row.caption;
        else v.caption=normalizeSubtitles(row.caption);
      }
      if(whole && row.speed !== undefined) v.speed = audioSpeed(row.speed);
      if(whole && row.srt) v.srt=normalizeSubtitles(row.srt);
      if(whole && row.follow!=null) {
        if(!Number.isInteger(row.follow)||row.follow<0||row.follow>=count)throw new Error('子工程跟随分镜无效。');
        v.follow=row.follow;
      }
      if(!whole && row.cut) v.cut=normalizeSegmentVoiceCuts([[row.cut]],[[id]])[0][0];
      return v;
    });
  }
  const result={};
  if(value.whole!==undefined)result.whole=tracks(value.whole,true);
  if(value.segments!==undefined) {
    if(!Array.isArray(value.segments)||value.segments.length>count)throw new Error('子工程分段口播无效。');
    const used=new Set();
    result.segments=value.segments.map(({index,items})=>{
      if(!Number.isInteger(index)||index<0||index>=count||used.has(index))throw new Error('子工程分段口播关联分镜无效。');
      used.add(index);return {index,items:tracks(items,false)};
    });
  }
  return result;
}

function projectVoiceConfig(config,project,base) {
  if(!base && !project.voice)return {};
  const primary=[{id:config.narrationId,srt:config.subtitles,speed:config.narrationSpeed},...(config.extraWholeTracks??[]).map((t)=>({id:t.narrationId,srt:t.subtitles,speed:t.narrationSpeed}))];
  const fallback=(id)=>({id,...(id && config.generatedCaptions?.[id] && {caption:config.generatedCaptions[id]})});
  const mainWhole=base?.whole ?? primary.map((t,i)=>({...fallback(t.id),...t,follow:config.wholeStartShots?.[i]}));
  const whole=project.voice?.whole ?? mainWhole;
  const caption={},ids=(config.shots??[]).map((s,i)=>base?[]:(config.segmentNarrationIds?.[i]??[]).map((id,j)=>id&&({...fallback(id),cut:config.segmentVoiceCuts?.[i]?.[j]})));
  for(const row of base?.segments??[])ids[row.index]=row.items;
  for(const row of project.voice?.segments??[])ids[row.index]=row.items;
  for(const row of [...whole,...ids.flat()])if(row?.id && row.caption)caption[row.id]=row.caption;
  return {narrationId:whole[0]?.id??null,narrationSpeed:whole[0]?.speed??1,subtitles:whole[0]?.srt??null,extraWholeTracks:whole.slice(1).map((r)=>({narrationId:r?.id??null,...(r?.speed && {narrationSpeed:r.speed}),subtitles:r?.srt??null})),
    wholeStartShots:whole.map((r)=>r?.follow??null),segmentNarrationIds:ids.map((row)=>row.map((r)=>r?.id??null)),
    segmentVoiceCuts:ids.map((row)=>row.map((r)=>r?.cut??null)),generatedCaptions:caption};
}

// Store only changed shots. Reordering in the editor carries the override with its shot.
function normalizeSubprojects(value, shotCount, mapShot, mapAudio=(id)=>id) {
  if (!value || !Array.isArray(value.projects) || !value.projects.length || value.projects.length > 1000) {
    throw new Error('子工程列表无效。');
  }
  function rows(entries) {
    if (!Array.isArray(entries) || entries.length > shotCount) throw new Error('子工程分镜数量无效。');
    const seen = new Set();
    return entries.map((entry) => {
      const index = entry?.index;
      if (!Number.isInteger(index) || index < 0 || index >= shotCount || seen.has(index)) throw new Error('子工程关联分镜无效。');
      seen.add(index);
      const clips=mapShot(entry.clips, index);
      return { index, clips, ...(entry.empty===true && !clips.length && {empty:true}) };
    });
  }
  const ids = new Set();
  const projects = value.projects.map((project) => {
    if (!project || typeof project.id !== 'string' || !/^[\w-]{1,80}$/.test(project.id) || ids.has(project.id)
        || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 80) throw new Error('子工程编号或名称无效。');
    ids.add(project.id);
    if (project.participates !== undefined && typeof project.participates !== 'boolean') throw new Error('子工程参与状态无效。');
    if (project.count !== undefined && (!Number.isInteger(project.count) || project.count < 1 || project.count > 1000)) throw new Error('子工程生成数量无效。');
    let variables;
    if(project.variables!==undefined){
      if(!Array.isArray(project.variables)||project.variables.length>100)throw new Error('子工程变量无效。');
      const seen=new Set();
      variables=project.variables.map(({key,text})=>{
        if(typeof key!=='string'||!key.trim()||key.length>50||/[{}\r\n=]/.test(key)||seen.has(key)||typeof text!=='string'||text.length>300)throw new Error('子工程变量名称或内容无效。');
        seen.add(key);return {key,text};
      });
    }
    if(project.scriptOverride!==undefined && (typeof project.scriptOverride!=='string'||project.scriptOverride.length>20000))throw new Error('子工程专属台词无效。');
    return { id: project.id, name: project.name.trim(), shots: rows(project.shots),...(project.scriptOverride && {scriptOverride:project.scriptOverride}),
      ...(variables && {variables}),...(project.voice && {voice:normalizeVoice(project.voice,shotCount,mapAudio)}),
      ...(project.participates !== undefined && { participates: project.participates }), ...(project.count !== undefined && { count: project.count }) };
  });
  if (value.active !== null && !ids.has(value.active)) throw new Error('找不到选中的子工程。');
  let categories;
  if(value.categories!==undefined) {
    if(!Array.isArray(value.categories)||value.categories.length>shotCount) throw new Error('子工程分类映射无效。');
    const seen=new Set();
    categories=value.categories.map(({index,category})=>{
      if(!Number.isInteger(index)||index<0||index>=shotCount||seen.has(index)||typeof category!=='string'||!category.trim()||category.length>260)throw new Error('分镜素材分类无效。');
      seen.add(index);return {index,category};
    });
  }
  return { active: value.active, main: rows(value.main), ...(categories && {categories}), ...(value.mainVoice && {mainVoice:normalizeVoice(value.mainVoice,shotCount,mapAudio)}), projects };
}

function resolveSubprojectShots(config) {
  const data = config.subprojects;
  const main = [...config.shots];
  for (const row of data.main) main[row.index] = row.clips;
  return new Map(data.projects.map((project) => {
    const effective = [...main];
    for (const row of project.shots) if (row.clips.length || row.empty) effective[row.index] = row.clips;
    return [project.id, { ...project, effective }];
  }));
}

module.exports = { normalizeSubprojects, resolveSubprojectShots, projectVoiceConfig };
