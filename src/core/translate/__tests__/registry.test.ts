import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  condenseRecords,
  ModelRegistry,
  REGISTRY_CDN,
  REGISTRY_MAX_AGE_MS,
  unpackModel,
  type RegistryRecord
} from '../registry'
import { REGISTRY_LOCATION_PREFIX, REGISTRY_SNAPSHOT } from '../registryData'
import type { PackedModel } from '../registryTypes'

function record(
  from: string,
  to: string,
  version: string,
  fileType: string,
  size = 100
): RegistryRecord {
  return {
    fromLang: from,
    toLang: to,
    version,
    fileType,
    attachment: {
      location: `${REGISTRY_LOCATION_PREFIX}${from}${to}/${version}/${fileType}.bin`,
      hash: fileType.padEnd(64, '0'),
      size
    }
  }
}

function release(from: string, to: string, version: string): RegistryRecord[] {
  return ['model', 'lex', 'vocab'].map((type) => record(from, to, version, type))
}

const PACKED: PackedModel[] = [
  {
    f: 'es',
    o: 'en',
    v: '1.0',
    x: [
      { t: 'model', s: 10, h: 'a', l: 'esen/1.0/model.bin' },
      { t: 'lex', s: 20, h: 'b', l: 'esen/1.0/lex.bin' },
      { t: 'vocab', s: 30, h: 'c', l: 'esen/1.0/vocab.spm' }
    ]
  },
  {
    f: 'en',
    o: 'de',
    v: '1.0',
    x: [
      { t: 'model', s: 10, h: 'a', l: 'ende/1.0/model.bin' },
      { t: 'lex', s: 20, h: 'b', l: 'ende/1.0/lex.bin' },
      { t: 'srcvocab', s: 5, h: 'c', l: 'ende/1.0/src.spm' },
      { t: 'trgvocab', s: 5, h: 'd', l: 'ende/1.0/trg.spm' }
    ]
  },
  {
    f: 'en',
    o: 'es',
    v: '1.0',
    x: [
      { t: 'model', s: 10, h: 'a', l: 'enes/1.0/model.bin' },
      { t: 'lex', s: 20, h: 'b', l: 'enes/1.0/lex.bin' },
      { t: 'vocab', s: 30, h: 'c', l: 'enes/1.0/vocab.spm' }
    ]
  }
]

describe('compareVersions', () => {
  it('orders releases above alphas of the same number', () => {
    expect(compareVersions('1.0', '1.0a1')).toBeGreaterThan(0)
    expect(compareVersions('1.0a2', '1.0a1')).toBeGreaterThan(0)
    expect(compareVersions('1.1a1', '1.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0', '1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1.0')).toBe(0)
  })
})

describe('condenseRecords', () => {
  it('keeps the newest complete release per pair and prefers releases over alphas', () => {
    const models = condenseRecords([
      ...release('es', 'en', '1.0'),
      ...release('es', 'en', '1.1'),
      ...release('es', 'en', '1.2a1'),
      ...release('es', 'en', '1.3').slice(0, 2),
      ...release('fr', 'en', '1.0a1'),
      record('de', 'en', '1.0', 'model'),
      { fromLang: 'it', toLang: 'en', version: '1.0', fileType: 'model' }
    ])
    expect(models.map((m) => `${m.f}-${m.o}@${m.v}`)).toEqual(['es-en@1.1', 'fr-en@1.0a1'])
    expect(models[0].x.map((f) => f.t)).toEqual(['model', 'lex', 'vocab'])
    expect(models[0].x[0].l).toBe('esen/1.1/model.bin')
  })

  it('packs split vocabularies as a source and a target file', () => {
    const models = condenseRecords([
      record('en', 'de', '1.0', 'model'),
      record('en', 'de', '1.0', 'lex'),
      record('en', 'de', '1.0', 'srcvocab'),
      record('en', 'de', '1.0', 'trgvocab')
    ])
    expect(models[0].x.map((f) => f.t)).toEqual(['model', 'lex', 'srcvocab', 'trgvocab'])
  })
})

describe('unpackModel', () => {
  it('rebuilds CDN URLs and sums the sizes', () => {
    const model = unpackModel(PACKED[0])
    expect(model.bytes).toBe(60)
    expect(model.files[0].url).toBe(`${REGISTRY_CDN}${REGISTRY_LOCATION_PREFIX}esen/1.0/model.bin`)
    expect(model.files[2].type).toBe('vocab')
  })
})

describe('ModelRegistry', () => {
  it('routes directly, through English, or not at all', () => {
    const registry = new ModelRegistry(PACKED)
    expect(registry.route({ from: 'es', to: 'en' })).toEqual([{ from: 'es', to: 'en' }])
    expect(registry.route({ from: 'es', to: 'de' })).toEqual([
      { from: 'es', to: 'en' },
      { from: 'en', to: 'de' }
    ])
    expect(registry.route({ from: 'de', to: 'es' })).toBeNull()
    expect(registry.route({ from: 'es', to: 'es' })).toBeNull()
    expect(registry.route({ from: 'en', to: 'fr' })).toBeNull()
    expect(registry.languages()).toEqual(['de', 'en', 'es'])
    expect(registry.sources('de')).toEqual(['en', 'es'])
    expect(registry.targets('es')).toEqual(['de', 'en'])
  })

  it('replaces its contents with a fresher copy and knows when it is stale', () => {
    const registry = new ModelRegistry(PACKED)
    expect(registry.fetchedAt).toBe(0)
    expect(registry.stale(1)).toBe(true)
    registry.replace([], 5)
    expect(registry.all()).toHaveLength(3)
    registry.replace(PACKED.slice(0, 1), 1000)
    expect(registry.all()).toHaveLength(1)
    expect(registry.packed()).toEqual(PACKED.slice(0, 1))
    expect(registry.stale(1000 + REGISTRY_MAX_AGE_MS - 1)).toBe(false)
    expect(registry.stale(1000 + REGISTRY_MAX_AGE_MS + 1)).toBe(true)
  })
})

describe('bundled snapshot', () => {
  const registry = new ModelRegistry()

  it('is complete and pairs every language with English', () => {
    expect(REGISTRY_SNAPSHOT.length).toBeGreaterThan(40)
    for (const model of registry.all()) {
      expect(model.from === 'en' || model.to === 'en').toBe(true)
      const types = model.files.map((file) => file.type)
      expect(types).toContain('model')
      expect(types).toContain('lex')
      expect(
        types.includes('vocab') || (types.includes('srcvocab') && types.includes('trgvocab'))
      ).toBe(true)
      for (const file of model.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(file.size).toBeGreaterThan(0)
        expect(file.url.startsWith(REGISTRY_CDN)).toBe(true)
      }
      expect(model.bytes).toBeLessThan(120 * 1024 * 1024)
    }
  })

  it('translates the common European languages both ways and pivots between them', () => {
    for (const code of ['es', 'de', 'fr', 'it', 'pt', 'nl', 'pl']) {
      expect(registry.route({ from: code, to: 'en' })).toHaveLength(1)
      expect(registry.route({ from: 'en', to: code })).toHaveLength(1)
    }
    expect(registry.route({ from: 'es', to: 'de' })).toHaveLength(2)
    expect(registry.route({ from: 'zh-Hans', to: 'en' })).toHaveLength(1)
  })
})
