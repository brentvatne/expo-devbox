import { registerWebModule, NativeModule } from 'expo';

// NativeCryptoModule is not available on the web platform.
class NativeCryptoModule extends NativeModule<{}> {}

export default registerWebModule(NativeCryptoModule, 'NativeCryptoModule');
