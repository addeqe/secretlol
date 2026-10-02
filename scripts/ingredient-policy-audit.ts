import {readFileSync,writeFileSync} from 'node:fs';
import {buildLinks,summarizeLinks} from '../src/ingredient-matching.ts';
import {DIETARY_POLICY} from '../src/dietary-policy.ts';
// Private working inputs/output: no credentials, recipe text or review data
// are copied into the public daily requirements file.
const [inventoryPath,cataloguePath,outputPath]=process.argv.slice(2);
if(!inventoryPath||!cataloguePath||!outputPath)throw new Error('Supply inventory, catalogue snapshot and output paths');
const inventory=JSON.parse(readFileSync(inventoryPath,'utf8'));
const catalogue=JSON.parse(readFileSync(cataloguePath,'utf8'));
if(!catalogue.snapshotId||!Array.isArray(catalogue.products)||!catalogue.products.length||
  catalogue.status?.products!=null&&catalogue.products.length!==catalogue.status.products)throw new Error('Invalid catalogue export');
if(catalogue.products.some((p:any)=>Date.now()-Date.parse(p.observedAt)>=86400000||!Number.isFinite(Date.parse(p.observedAt))))throw new Error('Fresh catalogue required for recipe eligibility');
const links=buildLinks(inventory.requirements,catalogue.products);
const exclusions=links.filter(l=>l.status==='excluded'||l.dietaryPolicy.meat&&l.status!=='matched')
  .map(l=>({name:l.name,occurrences:l.occurrences,reason:l.dietaryPolicy.blockedReason??'no_permitted_meat_match',
    meat:l.dietaryPolicy.meat,status:l.status,detail:l.reason}));
writeFileSync(outputPath,JSON.stringify({policy:DIETARY_POLICY,catalogueSnapshotId:catalogue.snapshotId,
  auditedAt:new Date().toISOString(),sourceInventory:inventory,exclusions,links},null,2)+'\n');
console.log(JSON.stringify({excludedNames:exclusions.length,source:summarizeLinks(links),audit:outputPath},null,2));
