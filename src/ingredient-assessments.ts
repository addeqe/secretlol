import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import type {Entry} from './types.ts';
import {DIETARY_POLICY_VERSION,policyText} from './dietary-policy.ts';

export type Assessment = {name:string;outcome:'approve'|'unavailable'|'clarify';approvedCodes:string[];
  basis:'kg'|'l'|'piece'|null;reason:string;evidence:string[];reviewedAt:string;reviewerModel:string;
  catalogueSnapshotId:string;catalogueIdentityHash:string;
  products:Array<{code:string;name:string;brand:string|null}>;parentAmended?:boolean;policyExclusion?:string|null};
export type AssessmentSet = {schemaVersion:number;policyVersion:string;baselineNames:number;
  baselineRunId:string;reviewedAt:string;reviewerModel:string;assessments:Assessment[]};
export const productIdentity = (p:{name:string;brand:string|null}) => `${policyText(p.name)}\n${policyText(p.brand??'')}`;
// Price/observation changes do not invalidate an identity review. New foods,
// changed identities or stock returning can invalidate a prior absence result.
export function catalogueIdentityHash(products:Entry[]){
  return createHash('sha256').update(JSON.stringify(products.map(p=>[p.code,productIdentity(p),p.available])
    .sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest('hex');
}
export function loadAssessments():{records:Record<string,Assessment>;report:Record<string,unknown>} {
  const path=new URL('../ingredient-data/review-decisions.json',import.meta.url);
  if(!existsSync(path))return {records:{},report:{reviewedNames:0}};
  const bytes=readFileSync(path),data=JSON.parse(bytes.toString()) as AssessmentSet;
  if(data.schemaVersion!==1||data.policyVersion!==DIETARY_POLICY_VERSION||
    !Number.isSafeInteger(data.baselineNames)||data.baselineNames!==data.assessments.length)throw new Error('Invalid review assessment manifest');
  const records:Record<string,Assessment>={};
  for(const a of data.assessments){
    if(!a.name||records[a.name]||!['approve','unavailable','clarify'].includes(a.outcome)||!a.reason?.trim()||
      !Array.isArray(a.evidence)||!a.evidence.length||!Array.isArray(a.approvedCodes)||
      !Array.isArray(a.products)||a.outcome==='approve'&&(!a.approvedCodes.length||!['kg','l','piece'].includes(a.basis??''))||
      a.outcome!=='approve'&&(a.approvedCodes.length||a.basis!==null)||
      a.approvedCodes.some(code=>!a.products.some(p=>p.code===code))||!a.catalogueIdentityHash||!a.reviewedAt||!a.reviewerModel){
      throw new Error('Invalid or incomplete ingredient assessment');
    }
    records[a.name]=a;
  }
  return {records,report:{baselineNeedsReviewNames:data.baselineNames,reviewedNames:data.assessments.length,
    reviewCoverage:1,baselineRunId:data.baselineRunId,reviewerModel:data.reviewerModel,reviewedAt:data.reviewedAt,
    outcomes:data.assessments.reduce((counts,a)=>(counts[a.outcome]=(counts[a.outcome]??0)+1,counts),{} as Record<string,number>),
    policyExcludedNames:data.assessments.filter(a=>a.policyExclusion).length,
    parentAmendedNames:data.assessments.filter(a=>a.parentAmended).length,
    assessmentHash:createHash('sha256').update(bytes).digest('hex'),correctnessCertified:false}};
}
