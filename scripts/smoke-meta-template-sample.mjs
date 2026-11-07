import { mkdtemp, cp, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=await mkdtemp(join(tmpdir(),'moda-sample-artifact-'));
try {
 await cp(new URL('../dist-cli/',import.meta.url),join(root,'dist-cli'),{recursive:true});
 await symlink(resolve('node_modules'),join(root,'node_modules'),'dir');
 await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}));
 const code=`globalThis.fetch=()=>{throw new Error('unexpected-network')};
 const {readPackagedMetaTemplateSample}=await import('./dist-cli/src/services/meta-template-management/sample-asset.js');
 const {provisionMetaTemplateSample}=await import('./dist-cli/src/services/meta-template-management/provision-sample.js');
 const receipt=await provisionMetaTemplateSample({environment:'development',mode:'plan'},{environment:()=> 'development',readPolicy:async()=>({bucketName:'public-media',publicOrigin:'https://media.example.com'})});
 if(receipt.outcome!=='PLANNED'||(await readPackagedMetaTemplateSample()).length!==28251)throw new Error('artifact-invalid');console.log(JSON.stringify(receipt));`;
 await writeFile(join(root,'smoke.mjs'),code);
 const result=spawnSync(process.execPath,['smoke.mjs'],{cwd:root,encoding:'utf8',timeout:15000});
 if(result.status!==0)throw new Error(result.stderr||'artifact-smoke-failed');
 console.log(result.stdout.trim());
} finally {await rm(root,{recursive:true,force:true});}
