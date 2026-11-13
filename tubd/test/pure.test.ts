import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { fixedHostPorts, lintTub, type ComposeConfig } from '../src/lint.ts';
import { MetaError, parseMeta } from '../src/meta.ts';
import { buildOverride } from '../src/override.ts';
import { allocatePort, takenPorts, type InstanceState } from '../src/state.ts';
import { mergeEnv } from '../src/store.ts';

const meta = parseMeta(`
name: notes
public: { service: app, port: 3000 }
export: { quiesce: [app], exclude: [data/db/] }
init: [node, init.mjs]
`);

describe('parseMeta', () => {
  it('reads every field and normalizes exclude paths', () => {
    assert.deepEqual(meta, {
      name: 'notes',
      public: { service: 'app', port: 3000 },
      export: { quiesce: ['app'], exclude: ['data/db'] },
      init: ['node', 'init.mjs'],
    });
  });
  it('rejects bad names, ports and escaping excludes', () => {
    assert.throws(() => parseMeta('name: Notes'), MetaError);
    assert.throws(() => parseMeta('name: notes\npublic: { service: app, port: 70000 }'), MetaError);
    assert.throws(() => parseMeta('name: notes\nexport: { exclude: [../x] }'), MetaError);
  });
});

describe('lintTub', () => {
  const dir = '/srv/tubs/notes';
  const config = (services: ComposeConfig['services']): ComposeConfig => ({ services });

  it('passes a tub that keeps its state in its own folder', () => {
    const issues = lintTub({
      tubDir: dir,
      meta,
      takenPorts: new Map(),
      config: config({
        app: { ports: [{ published: '8080', target: 3000 }], volumes: [{ type: 'bind', source: `${dir}/data/files`, target: '/data' }] },
      }),
    });
    assert.deepEqual(issues, []);
  });

  it('blocks named volumes and binds outside the tub', () => {
    const issues = lintTub({
      tubDir: dir,
      meta,
      takenPorts: new Map(),
      config: config({
        app: {},
        db: {
          volumes: [
            { type: 'volume', source: 'pg', target: '/var/lib/postgresql/data' },
            { type: 'bind', source: '/etc/passwd', target: '/x' },
            { type: 'bind', source: '/srv/tubs/notes-other/data', target: '/y' },
          ],
        },
      }),
    });
    assert.equal(issues.filter((i) => i.level === 'error').length, 3);
  });

  it("blocks another tub's host port but ignores the public service's own ports", () => {
    const issues = lintTub({
      tubDir: dir,
      meta,
      takenPorts: new Map([[1883, 'tub mqtt'], [8080, 'tub other']]),
      config: config({
        app: { ports: [{ published: '8080', target: 3000 }] },
        broker: { ports: [{ published: '1883', target: 1883 }] },
      }),
    });
    assert.deepEqual(issues, [{ level: 'error', service: 'broker', message: 'host port 1883 is already used by tub mqtt' }]);
  });

  it('reports a missing public service and unknown quiesce services', () => {
    const issues = lintTub({ tubDir: dir, meta, takenPorts: new Map(), config: config({ web: {} }) });
    assert.equal(issues.length, 2);
  });

  it('lists fixed host ports of non-public services', () => {
    assert.deepEqual(
      fixedHostPorts(config({ app: { ports: [{ published: '8080', target: 3000 }] }, broker: { ports: [{ published: 1883, target: 1883 }] } }), meta),
      [1883],
    );
  });
});

describe('buildOverride', () => {
  it('renames built images per tub and replaces the public ports', () => {
    const text = buildOverride('notes', meta, 20001, ['app']);
    assert.match(text, /ports: !override/);
    // The yaml library keeps unknown tags as plain values, enough to check the shape.
    const doc = parse(text, { customTags: [{ tag: '!override', resolve: (v: string) => v }] as never }) as {
      services: Record<string, { image?: string; ports?: string[] }>;
    };
    assert.equal(doc.services.app.image, 'tub-notes-app');
    assert.deepEqual(doc.services.app.ports, ['20001:3000']);
  });
  it('is empty when there is nothing to override', () => {
    assert.equal(buildOverride('x', { name: 'x', export: { quiesce: [], exclude: [] } }, undefined, []), 'services: {}\n');
  });
});

describe('ports', () => {
  const state: InstanceState = {
    tubs: {
      a: { port: 20000, fixedPorts: [1883], createdAt: '' },
      b: { port: 20002, fixedPorts: [], createdAt: '' },
    },
  };
  it('allocates the lowest free port', () => {
    assert.equal(allocatePort(state, [20000, 20005]), 20001);
    assert.equal(allocatePort(state, [20000, 20005], new Set([20001])), 20003);
  });
  it('fails when the range is full', () => {
    assert.throws(() => allocatePort(state, [20000, 20000]));
  });
  it('lists taken ports except the named tub', () => {
    assert.deepEqual([...takenPorts(state, 'a').keys()], [20002]);
  });
});

describe('mergeEnv', () => {
  it('keeps live values and adds only new keys', () => {
    assert.equal(mergeEnv('A=1\nB=2\n', 'A=9\nC=3\n'), 'A=1\nB=2\nC=3\n');
    assert.equal(mergeEnv('A=1', 'A=2'), 'A=1\n');
    assert.equal(mergeEnv('', 'X=1\n'), 'X=1\n');
  });
});
