import {it,expect,vi,afterEach} from 'vitest';
import {createHostedToken,refreshToken,validateToken} from '../server/authManager.js';
afterEach(()=>vi.restoreAllMocks());
it('authorized renewal extends active hosted access beyond the original hour',()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
 const first=createHostedToken('test-order','test-owner');now+=50*60*1000;
 const next=refreshToken(first,true)!;expect(next).toBeTruthy();expect(validateToken(first)).toBe(false);
 now+=20*60*1000;expect(validateToken(next)).toBe(true);
 now+=41*60*1000;expect(validateToken(next)).toBe(false);expect(refreshToken(next,true)).toBeNull();
});
it('ordinary refresh does not silently extend the hosted authorization cap',()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
 const first=createHostedToken('test-order','test-owner');now+=50*60*1000;
 const next=refreshToken(first)!;now+=11*60*1000;expect(validateToken(next)).toBe(false);
});
