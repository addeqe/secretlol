import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {candidate,reviewAttributeExclusion} from '../src/ingredient-matching.ts';
import {catalogueIdentityHash} from '../src/ingredient-assessments.ts';
import type {Assessment,AssessmentSet} from '../src/ingredient-assessments.ts';
import {ingredientPolicy,productPolicy,DIETARY_POLICY_VERSION} from '../src/dietary-policy.ts';
import type {Entry} from '../src/types.ts';

const folder=process.argv[2]??'data/luna-review',out=process.argv[3]??'ingredient-data/review-decisions.json';
const catalogue=JSON.parse(readFileSync(`${folder}/catalogue.json`,'utf8'));
const products=catalogue.products as Entry[],byCode=new Map(products.map(p=>[p.code,p]));
const pending=JSON.parse(readFileSync(`${folder}/pending.json`,'utf8')) as Array<{name:string;occurrences:number}>;
const inventory=new Map(pending.map(p=>[p.name,p])),seen=new Set<string>(),assessments:Assessment[]=[];
const checkedAt=new Date().toISOString(),identityHash=catalogueIdentityHash(products);
const parentAmended=new Set((JSON.parse(readFileSync(`${folder}/parent-corrections.json`,'utf8')) as Array<{name:string}>).map(r=>r.name));
const rejects:Array<{name:string;code:string;reason:string}>=[];
for(let index=1;index<=12;index++){
  const id=String(index).padStart(2,'0');
  const assigned=JSON.parse(readFileSync(`${folder}/batch-${id}.json`,'utf8')) as Array<{name:string}>;
  const results=JSON.parse(readFileSync(`${folder}/results-${id}.json`,'utf8')) as Assessment[];
  if(!Array.isArray(results)||results.length!==assigned.length||new Set(results.map(r=>r.name)).size!==assigned.length||
    results.some(r=>!assigned.some(a=>a.name===r.name)))throw new Error(`Batch ${id} is incomplete or contains foreign names`);
  for(const r of results){
    if(seen.has(r.name)||!inventory.has(r.name)||ingredientPolicy(r.name).blockedReason&&r.outcome==='approve'||
      !['approve','unavailable','clarify'].includes(r.outcome)||!r.reason?.trim()||
      !Array.isArray(r.evidence)||!r.evidence.length||!Array.isArray(r.approvedCodes)||
      r.outcome==='approve'&&(!r.approvedCodes.length||!['kg','l','piece'].includes(r.basis??''))||
      r.outcome!=='approve'&&(r.approvedCodes.length||r.basis!==null))throw new Error(`Invalid assessment in batch ${id}: ${r.name}`);
    seen.add(r.name);
    const codes=[...new Set(r.approvedCodes)],accepted:Entry[]=[];
    for(const code of codes){
      const p=byCode.get(code);
      const violation=!p?'unknown_product':productPolicy(p,r.name)??reviewAttributeExclusion(r.name,p)??
        candidate(p,r.basis!,Date.now()).exclusion;
      if(violation)rejects.push({name:r.name,code,reason:violation});else accepted.push(p!);
    }
    const policy=ingredientPolicy(r.name),policyExclusion=policy.blockedReason??(policy.meat&&r.outcome!=='approve'?'no_permitted_meat_match':null);
    assessments.push({...r,...(policyExclusion?{outcome:'unavailable' as const,reason:'Excluded from the active recipe inventory under the owner policy: '+policyExclusion}:{}),
      policyExclusion,parentAmended:parentAmended.has(r.name),approvedCodes:accepted.map(p=>p.code),products:accepted.map(p=>({code:p.code,name:p.name,brand:p.brand})),
      reviewedAt:checkedAt,reviewerModel:'gpt-6-luna',catalogueSnapshotId:catalogue.snapshotId,catalogueIdentityHash:identityHash});
  }
}
if(seen.size!==pending.length)throw new Error('Not every pending ingredient has been reviewed');
writeFileSync(`${folder}/validation-rejections.json`,JSON.stringify(rejects,null,2)+'\n');
if(rejects.length)throw new Error(`${rejects.length} proposed approvals failed validation; repair the specified batch results before publishing`);
assessments.sort((a,b)=>a.name.localeCompare(b.name));
const data:AssessmentSet={schemaVersion:1,policyVersion:DIETARY_POLICY_VERSION,baselineNames:pending.length,
  baselineRunId:'b550cb90-a3ad-457f-b296-e588b3d1a118',reviewedAt:checkedAt,reviewerModel:'gpt-6-luna',assessments};
writeFileSync(out,JSON.stringify(data,null,2)+'\n');
const outcomes=assessments.reduce((a,r)=>(a[r.outcome]=(a[r.outcome]??0)+1,a),{} as Record<string,number>);
console.log(JSON.stringify({reviewedNames:seen.size,reviewedOccurrences:pending.reduce((s,r)=>s+r.occurrences,0),outcomes,
  output:out,sourceHash:createHash('sha256').update(JSON.stringify(pending)).digest('hex')},null,2));
