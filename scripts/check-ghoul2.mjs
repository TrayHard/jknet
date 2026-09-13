import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {pathToFileURL} from 'node:url';
import {Vector3} from 'three';
const root=path.resolve(import.meta.dirname,'..');
const cache=path.join(root,'node_modules/.cache/ghoul2-check.mjs');fs.mkdirSync(path.dirname(cache),{recursive:true});
fs.writeFileSync(cache,ts.transpileModule(fs.readFileSync(path.join(root,'src/lib/ghoul2.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText);
const {readGlm,GhoulAnimation,readClips,deform,surfaceBolt}=await import(pathToFileURL(cache));
const fixtures=path.resolve(process.argv[2]??path.join(root,'../notes/model-check'));
const bytes=name=>{const b=fs.readFileSync(path.join(fixtures,name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};
const animation=new GhoulAnimation(bytes('models_players__humanoid__humanoid.gla'));
const clips=readClips(fs.readFileSync(path.join(fixtures,'models_players__humanoid_animation.cfg'),'utf8'));
const walk=clips.find(c=>c.name==='BOTH_WALK1');assert(walk);
for(const name of ['models_players_jedi_hm_model.glm','models_players_kyle_model.glm']){
 const mesh=readGlm(bytes(name));assert.equal(mesh.boneCount,53);let min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let changed=false,previous;
 let outward=0,inward=0;
 for(const surface of mesh.surfaces){if(surface.name.startsWith('*'))continue;for(let i=0;i<surface.indices.length;i+=3){const ids=Array.from(surface.indices.slice(i,i+3)),p=ids.map(j=>new Vector3().fromArray(surface.positions,j*3));const dot=p[1].sub(p[0]).cross(p[2].sub(p[0])).dot(new Vector3().fromArray(surface.normals,ids[0]*3));if(dot>1e-7)outward++;if(dot< -1e-7)inward++;}}
 assert(outward>100&&outward/(outward+inward)>0.95,'front faces must follow authored normals');
 for(const frame of [walk.first,walk.first+walk.count/2,walk.first+walk.count-1]){
  const pose=animation.pose(frame);
  for(const surface of mesh.surfaces){
   const positions=new Float32Array(surface.positions.length),normals=new Float32Array(surface.normals.length);deform(surface,pose,positions,normals);
   for(let i=0;i<positions.length;i++){assert(Number.isFinite(positions[i]));min[i%3]=Math.min(min[i%3],positions[i]);max[i%3]=Math.max(max[i%3],positions[i]);}
   if(surface===mesh.surfaces[0]){if(previous)changed ||=positions.some((p,i)=>Math.abs(p-previous[i])>0.01);previous=positions;}
  }
 }
 assert(changed);assert(max[2]-min[2]>20 && max[2]-min[2]<150);console.log(JSON.stringify({name,surfaces:mesh.surfaces.length,bones:mesh.boneCount,min,max,walk}));
 for (const hand of ['*r_hand','*l_hand']) {
  const tag=mesh.surfaces.find(s=>s.name===hand);assert(tag,hand);
  for (const clipName of ['BOTH_WALK2','BOTH_WALK_STAFF','BOTH_WALK_DUAL','BOTH_A1_SPECIAL','BOTH_A2_SPECIAL','BOTH_A3_SPECIAL','BOTH_A6_SABERPROTECT','BOTH_A7_SOULCAL']) {
   const clip=clips.find(c=>c.name===clipName);assert(clip);
   let previousBolt,moving=false;
   for (const fraction of [0,0.25,0.5,0.75,1]) {
    const positions=new Float32Array(tag.positions.length),normals=new Float32Array(tag.normals.length);
    deform(tag,animation.pose(clip.first+(clip.count-1)*fraction),positions,normals);
    const bolt=surfaceBolt(positions),origin=new Vector3().setFromMatrixPosition(bolt);
    assert(origin.distanceTo(new Vector3().fromArray(positions,6))<1e-6,'hilt origin follows the hand tag');
    const axes=[0,1,2].map(i=>new Vector3().setFromMatrixColumn(bolt,i));
    for (const axis of axes) assert(Math.abs(axis.length()-1)<1e-6);
    assert(Math.abs(axes[0].dot(axes[1]))<1e-6);assert(Math.abs(bolt.determinant()-1)<1e-6);
    if(previousBolt)moving ||=bolt.elements.some((v,i)=>Math.abs(v-previousBolt[i])>0.001);
    previousBolt=[...bolt.elements];
   }
   assert(moving,`${hand} follows ${clipName}`);
  }
 }
}
const saber=readGlm(bytes('models_weapons2_saber_1_saber_1.glm'));console.log(JSON.stringify({saberBones:saber.boneCount,animation:saber.animation,surfaces:saber.surfaces.length}));
assert.throws(()=>readGlm(new ArrayBuffer(20)));
console.log('Real Ghoul2 mesh, animation, deformation and truncation checks passed.');
