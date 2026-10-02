import{createServer}from'node:http';
import{readFileSync}from'node:fs';
import{randomBytes}from'node:crypto';
import{loadEnv,integer}from'../src/config.ts';
loadEnv('data/mealplanner.env');loadEnv('data/ingredient-review.env');
const base=process.env.PRICE_API_URL,readToken=process.env.PRICE_API_TOKEN,reviewToken=process.env.INGREDIENT_REVIEW_TOKEN;
if(!base||!readToken)throw new Error('Missing private catalogue connection. Configure data/mealplanner.env.');
const nonce=randomBytes(24).toString('hex'),port=integer('INGREDIENT_REVIEW_PORT',8789,1024,65535);
const html=readFileSync(new URL('../ingredient-data/review.html',import.meta.url),'utf8').replace('__NONCE__',nonce);
const origin=`http://127.0.0.1:${port}`;
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  try{
    if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403);res.end();return;}
    const url=new URL(req.url??'/',origin);
    if(url.pathname==='/'&&req.method==='GET'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    const routes:Record<string,string>={'/api/status':'/ingredients/status','/api/ingredients':'/ingredients',
      '/api/products':'/ingredients/products','/api/history':'/ingredients/history','/api/review':'/ingredients/review','/api/refresh':'/ingredients/refresh'};
    const path=routes[url.pathname];if(!path){res.writeHead(404);res.end();return;}
    const write=['/api/review','/api/refresh'].includes(url.pathname);
    if(req.method!==(write?'POST':'GET')){res.writeHead(405);res.end();return;}
    if(write&&(req.headers.origin!==origin||req.headers['x-review-nonce']!==nonce)){res.writeHead(403);res.end();return;}
    if(write&&!reviewToken){res.writeHead(503);res.end(JSON.stringify({error:'Review credential missing; configure data/ingredient-review.env'}));return;}
    let body='';if(write){for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>12000){res.writeHead(413);res.end();return;}}}
    const upstream=await fetch(`${base}${path}${url.search}`,{method:write?'POST':'GET',
      headers:{Authorization:`Bearer ${write?reviewToken:readToken}`,'Content-Type':'application/json'},
      ...(write?{body:body||'{}'}:{}),signal:AbortSignal.timeout(30000)});
    res.setHeader('Content-Type','application/json');res.writeHead(upstream.status);res.end(await upstream.text());
  }catch{res.writeHead(502);res.end(JSON.stringify({error:'Catalogue connection failed; retry.'}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Ingredient tracker: ${origin}\nCredentials stay in this local backend. Stop with Ctrl+C.`));
