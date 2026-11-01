/** Pure resource applicability values. Native callers attest origin and current
 * source/candidate authority; canonical JSON alone is never that attestation. */
import {digestCanonical,isSha256Hex} from './digest.ts';
import {InstalledDataResourceError,matchResourceApplicabilityProjection,validateInstalledDataResourceCapture,validateResourceApplicabilityProjection,type InstalledDataResourceCapture,type ResourceApplicabilityProjection,type InstalledDataAttemptOrigin} from './installed-data-resources.ts';
import type {ResourceApplicabilityBinding} from './records.types.ts';
const fields=['version','candidateDigest','definitionDigest','declarationDigest','sourceApplicabilityDigest','captureDigest','originDigest'];
export function isResourceApplicabilityBinding(value:unknown):value is ResourceApplicabilityBinding {
 if(typeof value!=='object'||value===null||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).sort().join(',')===[...fields].sort().join(',')&&v['version']==='installed-data-binding/1'&&fields.filter(k=>k!=='version').every(k=>isSha256Hex(v[k]));
}
export function validateResourceApplicabilityBinding(value:unknown):ResourceApplicabilityBinding {
 if(!isResourceApplicabilityBinding(value))throw new InstalledDataResourceError('installed_data_capture_invalid','Malformed resource applicability binding.');
 return structuredClone(value);
}
export function createResourceApplicabilityBinding(input:{readonly candidateDigest:string;readonly definitionDigest:string;readonly declarationDigest:string;readonly sourceApplicabilityDigest:string;readonly capture:InstalledDataResourceCapture;readonly projection:ResourceApplicabilityProjection;readonly originAttempt:InstalledDataAttemptOrigin}):ResourceApplicabilityBinding {
 const projection=validateResourceApplicabilityProjection(input.projection),capture=validateInstalledDataResourceCapture(input.capture);
 const match=matchResourceApplicabilityProjection(projection,{consumerId:projection.consumerId,declarationDigest:input.declarationDigest,sourceApplicabilityDigest:input.sourceApplicabilityDigest,capture,originAttempt:input.originAttempt});
 if(!match.applicable)throw new InstalledDataResourceError('installed_data_origin_invalid','Current native source/resource/origin does not match applicability projection.');
 return validateResourceApplicabilityBinding({version:'installed-data-binding/1',candidateDigest:input.candidateDigest,definitionDigest:input.definitionDigest,declarationDigest:input.declarationDigest,sourceApplicabilityDigest:input.sourceApplicabilityDigest,captureDigest:capture.digest,originDigest:digestCanonical(projection.origin)});
}
