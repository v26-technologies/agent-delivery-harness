/** Applicability is a distinct claim, never a passing command verdict. */
import {isInstalledDataConsumerDefinition} from '../config.ts';
import {isResourceApplicabilityBinding} from '../installed-data-evidence.ts';
import {sha256Hex} from '../digest.ts';
import type {DeclaredArtifact,ManifestValidationContext} from './envelope.ts';
import {GEN_1_UNKNOWN,GEN_4_MISSING,canonicallyEqual,checkMembers,type Collector} from './grammar.ts';
export function validateInstalledDataApplicable(payload:Record<string,unknown>,at:string,provider:{readonly id:unknown;readonly runId:unknown;readonly finalPassId:unknown},artifacts:readonly DeclaredArtifact[],context:Omit<ManifestValidationContext,'config'>&{readonly config:Pick<ManifestValidationContext['config'],'providers'>},collector:Collector):void {
 checkMembers(payload,at,{required:['verdict','binding'],optional:[]},{unknown:GEN_1_UNKNOWN,missing:GEN_4_MISSING},collector);
 const id=typeof provider.id==='string'?provider.id:undefined;
 const expected=id===undefined?undefined:context.resourceBindings?.[id];
 const declaration=context.config.providers.find(p=>p.id===id)?.check?.installedData;
 let artifactMatches=false;
 try {
  const text=context.artifactContents.get('resource-result.json');
  const slots=artifacts.filter(a=>a.path==='resource-result.json');
  artifactMatches=text!==undefined&&text.length<=65536&&slots.length===1&&slots[0]!.role==='resource-result'&&slots[0]!.sha256===sha256Hex(text)&&canonicallyEqual(JSON.parse(text),{providerId:provider.id,runId:provider.runId,finalPassId:provider.finalPassId,...payload});
 }catch{artifactMatches=false;}
 if(payload['verdict']!=='applicable'||!isInstalledDataConsumerDefinition(declaration)||!isResourceApplicabilityBinding(expected)||!isResourceApplicabilityBinding(payload['binding'])||!canonicallyEqual(payload['binding'],expected)||!artifactMatches)collector.emit('malformed_field','GEN-4',at,'resource applicability requires an opted-in consumer, complete independently expected native binding and matching retained result');
}
