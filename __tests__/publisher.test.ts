import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizedPublisher, publisherId, publisherSecret } from "@/lib/publisher-contract";
const mocks=vi.hoisted(()=>({findAccount:vi.fn(),findUnique:vi.fn(),findFirst:vi.fn(),upsert:vi.fn(),updateMany:vi.fn()}));
vi.mock("@/lib/db/client",()=>({prisma:{instagramAccount:{findFirst:mocks.findAccount},automation:{findUnique:mocks.findUnique,findFirst:mocks.findFirst,upsert:mocks.upsert,updateMany:mocks.updateMany}}}));
vi.mock("@/lib/meta/oauth",()=>({decryptToken:()=>"test-token"}));
import { POST, PATCH } from "@/app/api/publisher/route";
const secret="test-secret-with-at-least-32-characters";
const guide="https://opus-studio.xyz/hr/vodici/test-guide";
const payload={key:"test-package",instagramId:"222",name:"Test",guideUrl:guide,keywords:["VODIČ"],dmMessage:"Evo: {link}"};
const request=(method:string,body:unknown,auth=true)=>new Request("https://openreply.test/api/publisher",{method,headers:{"content-type":"application/json",...(auth?{Authorization:`Bearer ${secret}`}:{})},body:JSON.stringify(body)});
beforeEach(()=>{
  vi.clearAllMocks();process.env.PUBLISHER_SECRET=secret;process.env.PUBLISHER_INSTAGRAM_ACCOUNT_ID="creator";
  mocks.findAccount.mockResolvedValue({id:"creator",instagramId:"222",username:"markopejic.ai",workspaceId:"workspace",accessToken:"encrypted"});
  mocks.findUnique.mockResolvedValue(null);mocks.updateMany.mockResolvedValue({count:1});
  mocks.upsert.mockResolvedValue({id:publisherId(payload.key),isActive:false,postId:null,instagramAccountId:"creator",workspaceId:"workspace",name:payload.name,dmMessage:payload.dmMessage,keywords:payload.keywords,trackedLinks:[{slug:"test",destinationUrl:guide}]});
  vi.stubGlobal("fetch",vi.fn(async(url)=>String(url).startsWith("https://opus-studio.xyz")?new Response(`<link rel="canonical" href="${guide}"><h1>Test</h1><article class="cx-prose">Guide</article>`,{headers:{"content-type":"text/html"}}):Response.json({data:[{id:"333",permalink:"https://www.instagram.com/reel/test/"}]})));
});
describe("publisher integration",()=>{
  it("derives a purpose-specific child credential without accepting the parent credential",()=>{
    delete process.env.PUBLISHER_SECRET;process.env.CRON_SECRET="test-cron-secret-with-sufficient-length";
    const key=publisherSecret();expect(key).toHaveLength(64);expect(authorizedPublisher(`Bearer ${process.env.CRON_SECRET}`,key)).toBe(false);expect(authorizedPublisher(`Bearer ${key}`,key)).toBe(true);
  });
  it("requires a strong service secret and never touches the database without it",async()=>{
    expect(authorizedPublisher("Bearer short","short")).toBe(false);
    expect((await POST(request("POST",payload,false))).status).toBe(401);expect(mocks.findAccount).not.toHaveBeenCalled();
  });
  it("prepares an inactive, post-specific campaign with a stable key",async()=>{
    expect((await POST(request("POST",payload))).status).toBe(200);
    const data=mocks.upsert.mock.calls[0][0].create;
    expect(data.isActive).toBe(false);expect(data.matchAnyPost).toBe(false);expect(data.pendingNextReel).toBe(false);
    expect(data.id).toBe(publisherId(payload.key));
  });
  it("rejects inaccessible or foreign materials and mismatching accounts",async()=>{
    expect((await POST(request("POST",{...payload,guideUrl:"https://docs.google.com/test"}))).status).toBe(400);
    mocks.findAccount.mockResolvedValueOnce(null);expect((await POST(request("POST",payload))).status).toBe(403);
    vi.stubGlobal("fetch",vi.fn(async()=>new Response('Login',{status:200,headers:{'content-type':'text/html'}})));
    expect((await POST(request("POST",payload))).status).toBe(409);expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("refuses conflicting retries and another profile's post",async()=>{
    mocks.findUnique.mockResolvedValue({instagramAccountId:"another",workspaceId:"workspace"});
    expect((await POST(request("POST",payload))).status).toBe(409);
    mocks.findFirst.mockResolvedValue({id:publisherId(payload.key),postId:null,trackedLinks:[{destinationUrl:guide}]});
    expect((await PATCH(request("PATCH",{key:payload.key,instagramId:"222",postId:"999"}))).status).toBe(409);expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("activates only after verifying the actual post; cannot rebind",async()=>{
    mocks.findFirst.mockResolvedValue({id:publisherId(payload.key),postId:null,trackedLinks:[{destinationUrl:guide}]});
    expect((await PATCH(request("PATCH",{key:payload.key,instagramId:"222",postId:"333"}))).status).toBe(200);
    expect(mocks.updateMany.mock.calls[0][0].data).toMatchObject({postId:"333",isActive:true,pendingNextReel:false,matchAnyPost:false});
    mocks.findFirst.mockResolvedValue({postId:"different",trackedLinks:[]});expect((await PATCH(request("PATCH",{key:payload.key,instagramId:"222",postId:"333"}))).status).toBe(409);
  });
});
