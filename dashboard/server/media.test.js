import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizePhoto, reserveVideo, uploadPhoto, removeMedia } from './media.js';
import { createMediaStorage } from './media-storage.js';
import { createMediaObjectHandler, signature } from '../../supabase/functions/family-media-object/handler.mjs';

const photoRequest = (body, type = 'image/jpeg') => new Request('https://frame.test/api/media/test', { method:'PUT', headers:{'content-type':type}, body });
test('photos decode, orient, bound resolution and strip private metadata', async () => {
  const input = await sharp({create:{width:3000,height:1800,channels:3,background:'#7760a8'}}).withMetadata({orientation:6}).jpeg().toBuffer();
  const result = await normalizePhoto(photoRequest(input));
  assert.equal(result.width,1152); assert.equal(result.height,1920);
  const metadata = await sharp(result.data).metadata();
  assert.equal(metadata.exif,undefined); assert.equal(metadata.orientation,undefined); assert.equal(metadata.format,'jpeg');
  await assert.rejects(normalizePhoto(photoRequest('not an image')), {code:'invalid_photo'});
  await assert.rejects(normalizePhoto(photoRequest('<svg/>','image/svg+xml')), {code:'invalid_photo_type'});
  await assert.rejects(normalizePhoto(photoRequest(Buffer.alloc(3_000_001))), {code:'photo_too_large'});
});
test('frame, child and ordinary member cannot upload or remove collection media', async () => {
  for (const principal of [{authType:'frame',role:'frame'},{authType:'mobile',role:'child'},{authType:'user',role:'member'}]) {
    principal.household={id:'private'};
    for(const work of [()=>reserveVideo(null,principal,'x',{}),()=>uploadPhoto(null,principal,'x',null),()=>removeMedia(null,principal,'x')]) await assert.rejects(work,{code:'admin_required'});
  }
});
test('Edge storage capability binds operation, path, timestamp and bytes; rejects unsigned access', async () => {
  const secret='s'.repeat(64), key='11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg', time='1793480400000', body=new Uint8Array([1,2,3]);
  let calls=0;
  const handler=createMediaObjectHandler({secret,now:()=>Number(time),storage:{from(bucket){assert.equal(bucket,'family-media');return {upload:async()=>{calls++;return {data:{}}}}}}});
  const signed=await signature(secret,'upload',key,time,body);
  const request=(overrides={},bytes=body)=>new Request('https://edge.test',{method:'POST',headers:{'x-media-operation':'upload','x-media-key':key,'x-media-time':time,'x-media-signature':signed,...overrides},body:bytes});
  assert.equal((await handler(request())).status,200); assert.equal(calls,1);
  for(const headers of [{'x-media-signature':'x'},{'x-media-operation':'delete'},{'x-media-key':key.replace('.jpg','.mp4')},{'x-media-time':String(Number(time)-61000)},{'x-media-key':'../../private'}]) assert.equal((await handler(request(headers))).status,401);
  assert.equal((await handler(request({},new Uint8Array([4])))).status,401); assert.equal(calls,1);
});
test('server sends only its limited HMAC capability and rejects provider URL substitution', async () => {
  const env={SUPABASE_URL:'https://example.supabase.co',FAMILY_MEDIA_GATEWAY_KEY:'q'.repeat(64)};
  const storage=createMediaStorage(env,async(url,options)=>{
    assert.equal(url,'https://example.supabase.co/functions/v1/family-media-object'); assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,undefined); assert.equal(options.headers['x-media-operation'],'read-url');
    return Response.json({url:'https://evil.test/file'});
  });
  await assert.rejects(storage('read-url','x'),{code:'media_storage_unavailable'});
});
