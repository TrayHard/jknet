import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..');
const cache=path.join(root,'node_modules/.cache/model-scene-check');
fs.mkdirSync(cache,{recursive:true});
for(const name of ['ghoul2','md3','modelScene']) {
 let source=ts.transpileModule(fs.readFileSync(path.join(root,`src/lib/${name}.ts`),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText;
 source=source.replace(/from "\.\/(ghoul2|md3)"/g,'from "./$1.mjs"');
 fs.writeFileSync(path.join(cache,`${name}.mjs`),source);
}
const {loadModelScene}=await import(pathToFileURL(path.join(cache,'modelScene.mjs')));
const {readGlm, GhoulAnimation, matchSkeleton, deform}=await import(pathToFileURL(path.join(cache,'ghoul2.mjs')));
const assets=JSON.parse(fs.readFileSync(process.argv[2]??path.join(root,'../notes/library-qa/preview-fixes-assets/assets.json'),'utf8'));
const reads=[];
const load=async names=>{
 assert(names.every(name=>!/[\\:]/.test(name)&&!name.includes('..')&&!name.startsWith('/')),'only game-relative dependencies reach IPC');
 reads.push(...names);
 return assets.filter(asset=>names.includes(asset.name)||names.includes('@shaders')&&asset.name.endsWith('.shader')||names.includes('@sabers')&&asset.name.endsWith('.sab'));
};
const originalFetch=globalThis.fetch;
globalThis.fetch=async file=>new Response(fs.readFileSync(file));
try {
 for(const model of ['models/weapons2/bowcaster/bowcaster_w.glm','models/weapons2/stcomprifle/stcomprifle.glm','models/weapons2/stcomprifle/stcomprifle.md3']) {
  const scene=await loadModelScene({kind:'model',value:model},load);
  assert(scene.mesh.surfaces.some(surface=>surface.positions.length>0));
  assert([...scene.materials.values()].some(material=>material.path));
  assert(scene.materials.get('models/weapons2/stcomprifle/comp_rifle')?.path,'authored Windows shader paths resolve to the real rifle texture');
 }
 assert(reads.includes('models/weapons2/stcomprifle/comp_rifle.tga'));
 console.log('PASS: real JKHub 4336 GLM and MD3 scenes resolve Windows texture paths using bounded game-relative dependency requests.');
 const soldierPath=path.join(root,'../notes/library-qa/soldier-assets/assets.json');
 if(fs.existsSync(soldierPath)) {
  const soldier=JSON.parse(fs.readFileSync(soldierPath,'utf8'));
  assets.push(...soldier.filter(asset=>!assets.some(found=>found.name===asset.name)));
  const products=JSON.parse(fs.readFileSync(path.join(path.dirname(soldierPath),'products.json'),'utf8'));
  const characters=products.filter(product=>product.appearance?.parts);
  assert.equal(characters.length,19);
  for(const entry of characters) {
   const scene=await loadModelScene({kind:'character',value:entry.appearance.value},load);
   assert(scene.mesh.boneCount<=scene.animation.count);
   for(const clip of scene.clips.filter(clip=>['BOTH_WALK2','TORSO_WEAPONREADY3','BOTH_STAND2'].includes(clip.name))) {
    for(const surface of scene.mesh.surfaces) {
     const positions=new Float32Array(surface.positions.length),normals=new Float32Array(surface.normals.length);
     deform(surface,scene.animation.pose(clip.first),positions,normals);
     assert(positions.every(Number.isFinite)&&normals.every(Number.isFinite));
    }
   }
  }
  const droid=characters.find(entry=>entry.label==='Jedi bdroidpra');
  const bytes=fs.readFileSync(assets.find(asset=>asset.name===droid.model).path);
  const mesh=readGlm(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  assert.equal(mesh.boneCount,72,'fixture uses the older skeleton');
  const scene=await loadModelScene({kind:'character',value:droid.appearance.value},load);
  assert.equal(scene.mesh.boneCount,53,'old JK2 bone references are remapped to JKA');
  assert.throws(()=>matchSkeleton({...mesh,animation:'models/custom/other'},scene.animation),/Skeleton does not match/,'unrelated mismatches still fail');
  const parts=droid.appearance.parts;
  const changed=await loadModelScene({kind:'character',value:`jedi_bdroidpra/${parts.heads.at(-1).id}|${parts.torsos.at(-1).id}|${parts.legs.at(-1).id}`},load);
  assert.notDeepEqual([...changed.skins],[...scene.skins],'choosing other parts changes the actual surface assignments');
  console.log('PASS: 19 real Soldier Customization assemblies; finite animated vertices; 72-to-53 compatibility; unrelated skeleton mismatch rejected; interchangeable head, torso and legs.');
 }
} finally {globalThis.fetch=originalFetch;}
