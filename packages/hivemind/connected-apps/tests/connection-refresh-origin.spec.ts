import { describe,it,expect } from 'vitest'
import { connectionRefreshOrigin } from '../src/index.ts'
describe('authenticated connection refresh Origin',()=>{
  it('accepts only the exact HTTPS site origin',()=>{expect(connectionRefreshOrigin('https://next.singulancelabs.com','next.singulancelabs.com')).toBe(true)})
  it('rejects missing Origin, foreign domains, insecure URLs and malformed hints',()=>{
    for(const origin of [undefined,'null','https://attacker.example','http://next.singulancelabs.com','https://next.singulancelabs.com/path','https://next.singulancelabs.com/'])expect(connectionRefreshOrigin(origin,'next.singulancelabs.com')).toBe(false)
    expect(connectionRefreshOrigin('https://next.singulancelabs.com',undefined)).toBe(false)
  })
})
