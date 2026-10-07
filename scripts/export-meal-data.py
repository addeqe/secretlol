"""Package a verified SQLite release for a five-day, low-write D1 import."""
import argparse, collections, gzip, hashlib, json, pathlib, sqlite3, datetime
p=argparse.ArgumentParser();p.add_argument('database');p.add_argument('--output',default='data/meal-release');a=p.parse_args()
source=pathlib.Path(a.database).resolve();out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
c=sqlite3.connect(f'file:{source}?mode=ro',uri=True);c.row_factory=sqlite3.Row
j=lambda x:json.dumps(x,ensure_ascii=False,separators=(',',':'),allow_nan=False)
h=lambda b:hashlib.sha256(b).hexdigest()
dataset=h(source.read_bytes()); definitions=[dict(r) for r in c.execute('select * from filter_definitions order by filter_id')]
for d in definitions:d['rule']=json.loads(d.pop('rule_json'))
meta=dict(c.execute('select key,value from metadata'))
def fields(table,key):
 r=collections.defaultdict(list)
 for x in c.execute(f'select * from {table}'):
  v=dict(x);r[str(v.pop(key))].append(v)
 return r
ings=fields('ingredients','RecipeId');reviews=fields('reviews','RecipeId');filters=fields('recipe_filter_classifications','RecipeId');ifilters=fields('ingredient_filter_classifications','ingredient_name')
profiles={str(r['RecipeId']):dict(r) for r in c.execute('select * from recipe_filter_profiles')}
qualities={str(r['RecipeId']):dict(r) for r in c.execute('select * from recipe_ingredient_quality')}
connections={r['ingredient_name']:dict(r) for r in c.execute('select * from ingredient_product_connections')}
subjects=[dict(r) for r in c.execute('select * from ingredient_filter_subjects order by ingredient_name')]
requirements=[{'name':r['ingredient_name'],'occurrences':r['occurrences']} for r in subjects]
inventory={'recipes':len(profiles),'ingredientOccurrences':sum(r['occurrences'] for r in subjects),'requirements':requirements,'dietaryPolicy':json.loads(meta['willys_connections'])['dietaryPolicy']}
inventory_hash=h(j(requirements).encode());inventory['hash']=inventory_hash
sets=collections.defaultdict(list);days=[[] for _ in range(5)];table_counts={r[0]:c.execute('select count(*) from '+r[0]).fetchone()[0] for r in c.execute("select name from sqlite_master where type='table'")}
recipe_rows=list(c.execute('select * from recipes order by cast(RecipeId as integer)'));maximum=0;total_bytes=0
for index,row in enumerate(recipe_rows):
 raw=dict(row);rid=str(raw['RecipeId']);assert qualities[rid]['state']=='consistent'
 f=sorted(filters[rid],key=lambda r:r['filter_id']); ingredients=sorted(ings[rid],key=lambda r:r['ingredient_index'])
 assert ingredients and all(i['unit'] and i['ingredient_original'] in connections for i in ingredients)
 for x in f:sets[str(x['filter_id'])+':'+x['state']].append(int(rid))
 profile=profiles[rid].copy();profile['nutrition_metrics']=json.loads(profile.pop('nutrition_metrics_json'))
 doc={'source':raw,'ingredients':ingredients,'filters':f,'profile':profile,'quality':qualities[rid],'reviews':sorted(reviews[rid],key=lambda r:r['ReviewId'])}
 document=j(doc);size=len(document.encode());maximum=max(maximum,size);total_bytes+=size
 assert size<1900000,(rid,size)
 summary={'id':int(rid),'name':raw['Name'],'description':raw['Description'],'images':json.loads(raw['Images'] or '[]'),'category':raw['RecipeCategory'],'servings':raw['RecipeServings'],'yield':raw['RecipeYield'],'rating':raw['AggregatedRating'],'reviewCount':len(reviews[rid]),'prepTime':raw['PrepTime'],'cookTime':raw['CookTime'],'totalTime':raw['TotalTime'],'nutrientsPerServing':profile['nutrition_metrics']['nutrients_per_serving'],'filters':{str(x['filter_id']):x['state'] for x in f},'ingredientCount':len(ingredients)}
 rec={'id':int(rid),'name':raw['Name'],'names':j([i['ingredient_original'] for i in ingredients]),'summary':j(summary),'document':document,'hash':h(document.encode())}
 days[min(index*5//len(recipe_rows),4)].append(rec)
common={'inventory':inventory,'definitions':definitions,'metadata':meta,'classificationRuns':[dict(r) for r in c.execute('select * from classification_runs')],'sourceCounts':table_counts,'subjects':[],'sets':dict(sets)}
for r in subjects:
 name=r['ingredient_name'];link=connections[name];link['data']=json.loads(link.pop('data_json'))
 common['subjects'].append({'name':name,'occurrences':r['occurrences'],'filters':ifilters[name],'sourceConnection':link})
def save(name,data):
 content=data.encode();path=out/name
 with path.open('wb') as file:
  with gzip.GzipFile(filename='',mode='wb',fileobj=file,mtime=0) as zipped:zipped.write(content)
 return {'file':name,'sha256':h(path.read_bytes()),'bytes':path.stat().st_size,'uncompressedBytes':len(content)}
shared=save('common.json.gz',j(common));parts=[]
for day,records in enumerate(days,1):
 part=save(f'day-{day}.jsonl.gz','\n'.join(j(r) for r in records)+'\n');part.update(day=day,recipes=len(records),firstId=records[0]['id'],lastId=records[-1]['id'],maxEstimatedWrites=len(records)+(len(subjects)+len(sets)+10 if day==1 else 10));parts.append(part)
archive=out/'recipes_with_filters.sqlite.gz'
with source.open('rb') as src,archive.open('wb') as dst:
 with gzip.GzipFile(filename='',mode='wb',fileobj=dst,mtime=0) as z:
  while block:=src.read(1024*1024):z.write(block)
manifest={'schemaVersion':1,'datasetId':dataset,'sourceSha256':dataset,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'recipes':len(recipe_rows),'ingredientOccurrences':inventory['ingredientOccurrences'],'distinctIngredients':len(subjects),'reviews':table_counts['reviews'],'inventoryHash':inventory_hash,'filterSets':len(sets),'sourceCounts':table_counts,'common':shared,'parts':parts,'archive':{'file':archive.name,'sha256':h(archive.read_bytes()),'bytes':archive.stat().st_size},'documentBytes':total_bytes,'maxDocumentBytes':maximum,'releaseTag':'meal-data-2026-10-07','repository':'addeqe/secretlol'}
(out/'manifest.json').write_text(j(manifest)+'\n');pathlib.Path('meal-data/manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k not in ['sourceCounts']},indent=2))
