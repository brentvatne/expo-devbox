import { NativeModule, requireNativeModule } from 'expo';

declare class NativeCryptoModule extends NativeModule<{}> {
  sha256(message: string): string;
  sha512(message: string): string;
  hmacSha256Async(key: string, message: string): Promise<string>;
  randomBytes(count: number): string;
}

export default requireNativeModule<NativeCryptoModule>('NativeCrypto');
