/** Both execution layers preserve the public error contract without exposing internals. */
export function requestFailure(error: unknown): Response {
  const code=error instanceof Error?error.message:'';
  const known=['json_required','invalid_request','invalid_json','body_too_large','invalid_cursor','invalid_limit','invalid_offset','invalid_candidate_profile'];
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(known.includes(code))return Response.json({error:code},{status:code==='body_too_large'?413:400,headers});
  console.error('Catalogue request failed');
  return Response.json({error:'database_unavailable',message:'Check the service connection and free quotas.'},{status:503,headers});
}
