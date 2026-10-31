"""Official API authentication only. API accounts never represent web subscriptions."""
import json
import httpx

class ProviderFailure(Exception):
    def __init__(self,status): self.status=status

def invoke(provider,key,model,prompt,max_tokens):
    headers={'Content-Type':'application/json'}
    if provider=='openai':
        url='https://api.openai.com/v1/responses'
        headers['Authorization']='Bearer '+key
        payload={'model':model,'input':prompt,'max_output_tokens':max_tokens,'store':False}
    elif provider=='anthropic':
        url='https://api.anthropic.com/v1/messages'
        headers.update({'x-api-key':key,'anthropic-version':'2023-06-01'})
        payload={'model':model,'messages':[{'role':'user','content':prompt}],'max_tokens':max_tokens}
    elif provider=='google':
        # Model IDs are validated by the API schema before interpolation.
        url='https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent'
        headers['x-goog-api-key']=key
        payload={'contents':[{'parts':[{'text':prompt}]}],'generationConfig':{'maxOutputTokens':max_tokens}}
    else: raise ValueError('Unsupported provider')
    with httpx.Client(timeout=60,follow_redirects=False) as client:
        with client.stream('POST',url,headers=headers,json=payload) as r:
            if r.status_code>=300: raise ProviderFailure(r.status_code)
            buf=bytearray()
            for chunk in r.iter_bytes():
                buf.extend(chunk)
                if len(buf)>2_000_000: raise ValueError('Provider response too large')
            data=json.loads(buf)
    if provider=='openai':
        output='\n'.join(c.get('text','') for item in data.get('output',[]) for c in item.get('content',[]) if c.get('type')=='output_text')
        usage=data.get('usage',{}); inp=usage.get('input_tokens');out=usage.get('output_tokens')
    elif provider=='anthropic':
        output='\n'.join(c.get('text','') for c in data.get('content',[]) if c.get('type')=='text')
        usage=data.get('usage',{});inp=usage.get('input_tokens');out=usage.get('output_tokens')
    else:
        output='\n'.join(p.get('text','') for c in data.get('candidates',[]) for p in c.get('content',{}).get('parts',[]))
        usage=data.get('usageMetadata',{});inp=usage.get('promptTokenCount');out=usage.get('candidatesTokenCount')
        if isinstance(out,int): out+=usage.get('thoughtsTokenCount',0)
    if not isinstance(inp,int) or not isinstance(out,int) or inp<0 or out<0: inp=out=None
    return {'output':output,'input_tokens':inp,'output_tokens':out}
