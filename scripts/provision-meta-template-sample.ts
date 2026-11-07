import { parseProvisionSampleArguments, provisionMetaTemplateSample, provisionFailureReason } from '../src/services/meta-template-management/provision-sample.js';
import { META_TEMPLATE_SAMPLE_ASSET as asset } from '../src/services/meta-template-management/sample-asset.js';
async function main() {
  let options: ReturnType<typeof parseProvisionSampleArguments> | undefined;
  const failure = (reasonCode: string) => ({schemaVersion:1,environment:options?.environment ?? null,assetVersion:1,objectKey:asset.objectKey,sha256:asset.sha256,sizeBytes:asset.sizeBytes,contentType:asset.contentType,bucketName:null,publicOrigin:null,mode:options?.mode ?? 'plan',outcome:'FAILED',reasonCode});
  // Includes driver cleanup; non-cooperative infrastructure cannot hold the CLI open.
  const deadline = setTimeout(()=>{console.log(JSON.stringify(failure('DEADLINE')));process.exit(1);},60_000);
  let receipt: unknown;
  try { options = parseProvisionSampleArguments(process.argv.slice(2)); receipt = await provisionMetaTemplateSample(options); }
  catch(error) { receipt=failure(provisionFailureReason(error));process.exitCode=1; }
  finally {
    try { if(options) {const {default:prisma}=await import('../src/lib/db.js');await prisma.$disconnect();} }
    catch {receipt=failure('CLEANUP_FAILED');process.exitCode=1;}
    finally {clearTimeout(deadline);}
  }
  console.log(JSON.stringify(receipt));
}
void main();
