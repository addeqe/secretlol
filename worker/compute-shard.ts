// A fixed pool bounds the number of compute objects. An exact request prefix
// keeps retries together so ephemeral caches can help; affinity is never needed
// for correctness. The gateway neither parses JSON nor buffers whole bodies.
export const COMPUTE_SHARDS=32;
export async function computeShard(request: Request): Promise<string> {
  const key=`${request.method}:${request.url}`.slice(0,512);
  let hash=2166136261;
  for(let index=0;index<key.length;index++)hash=Math.imul(hash^key.charCodeAt(index),16777619);
  if(request.body){
    const reader=request.clone().body!.getReader();
    let remaining=4096;
    try{
      while(remaining>0){
        const {value,done}=await reader.read();if(done)break;
        const count=Math.min(remaining,value.length);
        for(let index=0;index<count;index++)hash=Math.imul(hash^value[index],16777619);
        remaining-=count;
      }
    }finally{
      // A tee's cancellation resolves after its other branch is consumed by the
      // compute service, so do not await it before forwarding that original body.
      void reader.cancel().catch(()=>{});
    }
  }
  return `meal-compute-v1-${(hash>>>0)%COMPUTE_SHARDS}`;
}
