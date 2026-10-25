import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import NativeCrypto from './modules/native-crypto/src/NativeCryptoModule';

type Result = { name: string; pass: boolean; detail: string };

// Known-answer vectors: FIPS 180-2 for SHA-256, SHA-384 and SHA-512, and RFC 4231 test case 2 for HMAC-SHA256.
async function runTests(): Promise<Result[]> {
  const results: Result[] = [];
  const check = async (name: string, fn: () => unknown, expect: (v: any) => boolean) => {
    try {
      const value = await fn();
      results.push({ name, pass: expect(value), detail: String(value) });
    } catch (e: any) {
      results.push({ name, pass: expect(e), detail: `threw: ${e.message}` });
    }
  };

  await check('sha256("abc")', () => NativeCrypto.sha256('abc'), (v) =>
    v === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await check('sha256("")', () => NativeCrypto.sha256(''), (v) =>
    v === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  await check('sha384("abc")', () => NativeCrypto.sha384('abc'), (v) =>
    v === 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7');
  await check('sha512("abc")', () => NativeCrypto.sha512('abc'), (v) =>
    v === 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
  await check('hmacSha256Async (RFC 4231 #2)',
    () => NativeCrypto.hmacSha256Async('Jefe', 'what do ya want for nothing?'), (v) =>
    v === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  await check('randomBytes(16)', () => NativeCrypto.randomBytes(16), (v) =>
    typeof v === 'string' && /^[0-9a-f]{32}$/.test(v));
  await check('randomBytes(0) throws', () => NativeCrypto.randomBytes(0), (v) =>
    v instanceof Error && v.message.includes('Pass a count from 1 to 1024'));
  return results;
}

export default function App() {
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    runTests().then((r) => {
      setResults(r);
      for (const { name, pass, detail } of r) {
        console.log(`[native-crypto] ${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
      }
      const failed = r.filter((x) => !x.pass).length;
      console.log(`[native-crypto] DONE ${r.length - failed}/${r.length} passed`);
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>NativeCrypto</Text>
      {results.map(({ name, pass, detail }) => (
        <Text key={name} style={[styles.row, { color: pass ? '#137333' : '#c5221f' }]}>
          {pass ? '✓' : '✗'} {name}
          {'\n'}
          <Text style={styles.detail}>{detail}</Text>
        </Text>
      ))}
      <StatusBar style="auto" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 80 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 16 },
  row: { fontSize: 15, marginBottom: 12 },
  detail: { fontSize: 11, color: '#555', fontFamily: 'Menlo' },
});
