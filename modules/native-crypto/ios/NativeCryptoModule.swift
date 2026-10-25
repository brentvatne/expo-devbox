import CryptoKit
import ExpoModulesCore
import Security

public class NativeCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeCrypto")

    OnCreate {
      NSLog("[native-crypto] module created")
    }

    Function("sha256") { (message: String) -> String in
      return SHA256.hash(data: Data(message.utf8)).hexString
    }

    Function("sha384") { (message: String) -> String in
      return SHA384.hash(data: Data(message.utf8)).hexString
    }

    Function("sha512") { (message: String) -> String in
      return SHA512.hash(data: Data(message.utf8)).hexString
    }

    AsyncFunction("hmacSha256Async") { (key: String, message: String) -> String in
      let mac = HMAC<SHA256>.authenticationCode(
        for: Data(message.utf8),
        using: SymmetricKey(data: Data(key.utf8))
      )
      return Data(mac).hexString
    }

    Function("randomBytes") { (count: Int) throws -> String in
      guard count > 0, count <= 1024 else {
        throw InvalidByteCountException(count)
      }
      var bytes = [UInt8](repeating: 0, count: count)
      let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
      guard status == errSecSuccess else {
        throw RandomBytesFailedException(status)
      }
      return Data(bytes).hexString
    }
  }
}

private final class InvalidByteCountException: GenericException<Int> {
  override var reason: String {
    "randomBytes was called with \(param) bytes. Pass a count from 1 to 1024."
  }
}

private final class RandomBytesFailedException: GenericException<OSStatus> {
  override var reason: String {
    "SecRandomCopyBytes failed with status \(param). The system random number generator is unavailable; try again."
  }
}
