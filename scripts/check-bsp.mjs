import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {pathToFileURL} from 'node:url';

const root=path.resolve(import.meta.dirname,'..'),cache=path.join(root,'node_modules/.cache/bsp-check');
fs.mkdirSync(cache,{recursive:true});
for(const name of ['bsp','ghoul2','mapScene']) {
 let source=ts.transpileModule(fs.readFileSync(path.join(root,`src/lib/${name}.ts`),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 source=source.replace(/from "\.\/(bsp|ghoul2)"/g,'from "./$1.mjs"');fs.writeFileSync(path.join(cache,`${name}.mjs`),source);
}
const {readBsp,mapCluster,mapBatchVisible}=await import(pathToFileURL(path.join(cache,'bsp.mjs')));
const {mapMaterial}=await import(pathToFileURL(path.join(cache,'mapScene.mjs')));
const {blocks}=await import(pathToFileURL(path.join(cache,'ghoul2.mjs')));
// Synthetic fixtures keep format/security regressions runnable without game assets.
function fixture(patch=false) {
 const lumps=Array.from({length:18},()=>Buffer.alloc(0));
 lumps[0]=Buffer.from('{ "classname" "worldspawn" "message" "Test map" } { "classname" "info_player_deathmatch" "origin" "16 32 48" "angle" "90" }\0');
 lumps[1]=Buffer.alloc(72);lumps[1].write('textures/test');
 lumps[2]=Buffer.alloc(16);lumps[2].writeFloatLE(1,0);lumps[2].writeFloatLE(64,12);
 lumps[3]=Buffer.alloc(36);lumps[3].writeInt32LE(-1,4);lumps[3].writeInt32LE(-2,8);
 lumps[4]=Buffer.alloc(96);lumps[4].writeInt32LE(1,36);lumps[4].writeInt32LE(1,48);
 lumps[5]=Buffer.alloc(4);lumps[7]=Buffer.alloc(40);
 for(const at of [12,16,20])lumps[7].writeFloatLE(128,at);
 lumps[7].writeInt32LE(1,28);
 const vertices=patch?Array.from({length:9},(_,i)=>[i%3*64,Math.floor(i/3)*64,i===4?64:0]):[[0,0,0],[128,0,0],[0,128,0]];
 lumps[10]=Buffer.alloc(vertices.length*80);
 for(const [i,p] of vertices.entries()) {
  p.forEach((value,j)=>lumps[10].writeFloatLE(value,i*80+j*4));
  lumps[10].writeFloatLE(1,i*80+60);lumps[10].writeFloatLE(Number.NaN,i*80+20);
  for(let j=0;j<4;j++)lumps[10][i*80+64+j]=255;
 }
 lumps[11]=Buffer.alloc(12);lumps[11].writeInt32LE(1,4);lumps[11].writeInt32LE(2,8);
 lumps[13]=Buffer.alloc(148);lumps[13].writeInt32LE(patch?2:1,8);lumps[13].writeInt32LE(vertices.length,16);lumps[13].writeInt32LE(3,24);lumps[13].writeInt32LE(-3,36);
 if(patch){lumps[13].writeInt32LE(3,140);lumps[13].writeInt32LE(3,144);}
 lumps[14]=Buffer.alloc(128*128*3,64);lumps[16]=Buffer.alloc(10);lumps[16].writeInt32LE(2,0);lumps[16].writeInt32LE(1,4);lumps[16][8]=1;lumps[16][9]=2;
 const buffer=Buffer.alloc(152+lumps.reduce((sum,lump)=>sum+lump.length,0));buffer.write('RBSP');buffer.writeInt32LE(1,4);
 let at=152;for(const [i,lump] of lumps.entries()){buffer.writeInt32LE(at,8+i*8);buffer.writeInt32LE(lump.length,12+i*8);lump.copy(buffer,at);at+=lump.length;}
 return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.length);
}
const basic=readBsp(fixture()),curved=readBsp(fixture(true));
assert.equal(basic.title,'Test map');assert.deepEqual(basic.spawns[0],{position:[16,74,-32],yaw:0,pitch:-0});
assert.equal(basic.batches[0].indices.length,3);assert.equal(curved.batches[0].indices.length,96);
assert.deepEqual([...curved.batches[0].positions.slice(36,39)],[64,16,-64]);
assert.equal(mapCluster(basic,{x:80,y:0,z:0}),0);assert.equal(mapCluster(basic,{x:16,y:0,z:0}),1);
assert.equal(mapBatchVisible(basic,basic.batches[0],0),true);assert.equal(mapBatchVisible(basic,basic.batches[0],1),false);
const corrupt=(lump,offset,value)=>{const b=fixture(true),v=new DataView(b);v.setInt32(v.getInt32(8+lump*8,true)+offset,value,true);return b;};
assert.throws(()=>readBsp(corrupt(3,4,0)),/Invalid BSP/,'cyclic node trees must be rejected');
assert.throws(()=>readBsp(corrupt(13,140,4)),/Invalid BSP/,'patch dimensions must be odd');
assert.throws(()=>readBsp(corrupt(13,36,0)),/Invalid BSP/,'used lightmap coordinates must be finite');
assert.throws(()=>readBsp(fixture().slice(0,100)),/Invalid BSP/);
const white=mapMaterial('{ map $whiteimage rgbGen const ( 1 1 0 ) }','colors/yellow',0);
assert.equal(white.image,null);assert.deepEqual(white.color,[1,1,0]);
assert.equal(mapMaterial('surfaceparm fog','fog',0).skip,true);
assert.equal(mapMaterial('{ map $lightmap } { map textures/stone blendFunc filter }','stone',0).blend,null);
assert.equal(mapMaterial('{ oneshotanimMap 1 textures/a textures/b }','anim',0).image,'textures/a');
assert.equal(mapMaterial('qer_editorimage textures/poster { videoMap movies/loop }','video',0).image,'textures/poster');
assert.equal(mapMaterial('{ map ../../secret.png }','../../secret',0).image,null);
console.log('PASS: synthetic triangles/Bezier patches, coordinate conversion, PVS, malformed nodes/UVs/patches and shader materials.');
const directory=path.resolve(process.argv[2]??path.join(root,'../notes/library-qa/map-assets'));
const reports=[];
for(const game of ['ja','jo','atlantica']) {
 const folder=path.join(directory,game);
 if(!fs.existsSync(path.join(folder,'assets.json')))continue;
 const assets=JSON.parse(fs.readFileSync(path.join(folder,'assets.json'),'utf8'));
 const shaders=blocks(assets.map(asset=>(asset.text??'').replaceAll('\\','/')).join('\n'));
 const requests=new Set();
 for(const asset of assets.filter(asset=>asset.name.endsWith('.bsp'))) {
  const data=fs.readFileSync(asset.path),buffer=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
  const began=performance.now(),map=readBsp(buffer);
  const vertices=map.batches.reduce((sum,batch)=>sum+batch.positions.length/3,0),triangles=map.batches.reduce((sum,batch)=>sum+batch.indices.length/3,0);
  assert(vertices>100&&triangles>100&&map.spawns.length>0);
  for(const batch of map.batches){assert(batch.positions.every(Number.isFinite));assert(batch.indices.every(index=>index<batch.positions.length/3));}
  const position=map.spawns[0].position,cluster=mapCluster(map,{x:position[0],y:position[1],z:position[2]});
  const visible=map.batches.filter(batch=>mapBatchVisible(map,batch,cluster)).length;
  assert(visible>0);console.log({map:asset.name,cluster,visible,total:map.batches.length,spawn:position});if(map.visibility.length)assert(cluster>=0,'player spawn resolves to a BSP leaf');
  for(const shader of map.shaders) {
   const spec=mapMaterial(shaders.get(shader.name)??'',shader.name,shader.flags);
   const bases=[...(!spec.skip&&spec.image?[spec.image]:[]),...(spec.sky?['rt','lf','up','dn','ft','bk'].map(side=>spec.sky+'_'+side):[])];
   for(const base of bases)for(const ext of ['.tga','.jpg','.png','.jpeg'])requests.add(base+ext);
  }
  assert.throws(()=>readBsp(buffer.slice(0,100)),/Invalid BSP/);
  const bad=buffer.slice(0),view=new DataView(bad);view.setInt32(8+10*8,buffer.byteLength-4,true);assert.throws(()=>readBsp(bad),/Invalid BSP/);
  const badIndices=buffer.slice(0),indexView=new DataView(badIndices),indexOffset=indexView.getInt32(8+11*8,true);indexView.setInt32(indexOffset,0x7fffffff,true);assert.throws(()=>readBsp(badIndices),/Invalid BSP/);
  reports.push({game,map:asset.name,vertices,triangles,batches:map.batches.length,visibleAtSpawn:visible,spawns:map.spawns.length,parseMs:Math.round(performance.now()-began)});
 }
 fs.writeFileSync(path.join(folder,'requested.json'),JSON.stringify([...requests]));
}
if(reports.length)fs.writeFileSync(path.join(directory,'checks.json'),JSON.stringify(reports,null,2));
console.log(JSON.stringify(reports,null,2));
console.log(reports.length?'PASS: real RBSP maps, tessellated geometry, texture requests, spawn points, PVS culling, malformed bounds and indices.':'Real map checks skipped: optional local game fixtures are absent.');
