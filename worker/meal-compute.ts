import {handle,type Env} from './service.ts';
import {requestFailure} from './http-errors.ts';
import {WorkerQuoteResponseCache} from './retailers.ts';

// Multiple objects can share an isolate and its 128 MiB heap. Share one bounded
// cache so the fixed shard pool cannot multiply the nominal memory allowance.
const computeQuoteCache=new WorkerQuoteResponseCache({memoryEnabled:true});

/** Compute-only SQLite-backed DO: no storage calls, alarms or background timers. */
export class MealCompute {
  readonly env: Env;
  constructor(_state: DurableObjectState,env: Env) {
    this.env={...env,COMPUTE_QUOTE_CACHE:computeQuoteCache};
  }
  async fetch(request: Request): Promise<Response> {
    try {return await handle(request,this.env);}
    catch(error){return requestFailure(error);}
  }
}
