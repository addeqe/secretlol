import type {Entry} from './types.ts';
export type Pack={label:string;quantity:number|null;unit:'g'|'ml'|'piece'|null;drainedGrams:number|null;approximate:boolean};
export function packInfo(entry: Entry): Pack {
  const label = typeof entry.raw?.displayVolume === 'string' ? entry.raw.displayVolume : '';
  const text = label.toLowerCase().replace(/,/g,'.').replace(/\s/g,'').replace(/^ca:?/, '');
  let quantity: number | null = null, unit: Pack['unit'] = null, drainedGrams: number | null = null;
  const weight = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(kg|g)$/.exec(text);
  const cubes = /^(\d+)(?:p|st)\/\d+(?:\.\d+)?l$/.exec(text);
  const multi = /^(?:(\d+)x)?(\d+(?:\.\d+)?)(kg|g|ml|cl|dl|l|p|st|pack)$/.exec(text);
  if(cubes){quantity=Number(cubes[1]);unit='piece';}
  else if (weight) { const scale=weight[3]==='kg'?1000:1; quantity=Number(weight[1])*scale; drainedGrams=Number(weight[2])*scale;unit='g'; }
  else if (multi) {
    const scale: Record<string,number>={kg:1000,g:1,l:1000,dl:100,cl:10,ml:1,p:1,st:1,pack:1};
    quantity=Number(multi[1]??1)*Number(multi[2])*scale[multi[3]];
    unit=/^(kg|g)$/.test(multi[3])?'g':/^(ml|cl|dl|l)$/.test(multi[3])?'ml':'piece';
  }
  return {label,quantity,unit,drainedGrams,approximate:/^ca/i.test(label) || /kr\/kg/i.test(entry.priceUnit)};
}
