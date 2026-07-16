import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse,
  serialize,
  setEntry,
  rawToTyped,
  typedToRaw,
  synthesizeFile,
} from '../src/palSettings.js';

const SAMPLE =
  '[/Script/Pal.PalGameWorldSettings]\r\n' +
  'OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,ExpRate=1.000000,' +
  'DeathPenalty=All,bEnableFastTravel=True,' +
  'ServerName="My Server, with a comma and = sign",' +
  'AdminPassword="s3cret,pw",' +
  'CrossplayPlatforms=(Steam,Xbox,PS5,Mac),' +
  'RESTAPIEnabled=True,RESTAPIPort=8212)\r\n';

test('round-trips byte-exact when nothing changes', () => {
  assert.equal(serialize(parse(SAMPLE)), SAMPLE);
});

test('parses quoted strings containing commas and equals', () => {
  const p = parse(SAMPLE);
  assert.equal(p.entries.get('ServerName'), '"My Server, with a comma and = sign"');
  assert.equal(p.entries.get('AdminPassword'), '"s3cret,pw"');
});

test('parses nested paren tuples as one value', () => {
  const p = parse(SAMPLE);
  assert.equal(p.entries.get('CrossplayPlatforms'), '(Steam,Xbox,PS5,Mac)');
});

test('preserves key order, unknown keys, and CRLF after an edit', () => {
  const p = parse(SAMPLE);
  setEntry(p, 'ExpRate', typedToRaw(2.5, 'float'));
  const out = serialize(p);
  assert.match(out, /ExpRate=2\.5,DeathPenalty=All/);
  assert.match(out, /AdminPassword="s3cret,pw"/);
  assert.match(out, /CrossplayPlatforms=\(Steam,Xbox,PS5,Mac\)/);
  assert.ok(out.includes('\r\n'));
  // Everything except the one value is unchanged.
  assert.equal(out.replace('ExpRate=2.5', 'ExpRate=1.000000'), SAMPLE);
});

test('appends new keys at the end of the tuple', () => {
  const p = parse(SAMPLE);
  setEntry(p, 'bHardcore', typedToRaw(true, 'bool'));
  assert.match(serialize(p), /RESTAPIPort=8212,bHardcore=True\)/);
});

test('throws when no OptionSettings line exists', () => {
  assert.throws(() => parse('[/Script/Pal.PalGameWorldSettings]\n'), /OptionSettings/);
});

test('value coercion both directions', () => {
  assert.equal(rawToTyped('True', 'bool'), true);
  assert.equal(rawToTyped('False', 'bool'), false);
  assert.equal(rawToTyped('1.000000', 'float'), 1);
  assert.equal(rawToTyped('8212', 'int'), 8212);
  assert.equal(rawToTyped('"hi, there"', 'string'), 'hi, there');
  assert.equal(rawToTyped('None', 'enum'), 'None');
  assert.equal(typedToRaw(true, 'bool'), 'True');
  assert.equal(typedToRaw(2, 'float'), '2.000000');
  assert.equal(typedToRaw(2.5, 'float'), '2.5');
  assert.equal(typedToRaw(31.9, 'int'), '32');
  assert.equal(typedToRaw('a"b', 'string'), '"a\\"b"');
});

test('synthesizeFile produces parseable output', () => {
  const text = synthesizeFile([
    ['ExpRate', '1.000000'],
    ['bEnableFastTravel', 'True'],
  ]);
  const p = parse(text);
  assert.deepEqual(p.order, ['ExpRate', 'bEnableFastTravel']);
});
