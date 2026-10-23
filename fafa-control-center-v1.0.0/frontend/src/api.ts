export class ApiError extends Error { constructor(public status:number, message:string){super(message)} }
let csrfPromise:Promise<string>|null=null;
async function csrf():Promise<string>{
 if(!csrfPromise)csrfPromise=fetch('/api/v1/auth/csrf',{credentials:'include'}).then(async r=>{if(!r.ok)throw new Error('CSRF initialization failed');return (await r.json()).csrf_token as string}).catch(e=>{csrfPromise=null;throw e});
 return csrfPromise;
}
export async function api<T=Record<string,unknown>>(path:string,method='GET',body?:unknown,retryCsrf=true):Promise<T>{
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(method!=='GET')headers['X-CSRF-Token']=await csrf();
 const r=await fetch('/api/v1'+path,{method,headers,credentials:'include',body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json();
 if(!r.ok){
  // Another tab may have rotated the shared CSRF Cookie. Retry only explicit CSRF
  // rejection: the server rejected the mutation before executing business logic.
  if(r.status===403&&retryCsrf&&method!=='GET'&&typeof data.detail==='string'&&data.detail.includes('CSRF')){
   csrfPromise=null;return api<T>(path,method,body,false);
  }
  if(r.status===401)window.dispatchEvent(new Event('session-expired'));
  throw new ApiError(r.status,typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));
 }
 return data as T;
}
