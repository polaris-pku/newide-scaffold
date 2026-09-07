---
name: mobile-app-security
description: Audits Android and iOS applications for security issues - local storage, networking, platform APIs and hardening. Use when reviewing mobile apps for vulnerabilities.
---

# Mobile Security Audit

This skill performs static code analysis for mobile application security vulnerabilities across Android (Java/Kotlin), iOS (Swift/Objective-C), React Native (JavaScript/TypeScript), and Flutter (Dart) projects. It identifies vulnerabilities mapped to all 10 OWASP Mobile Top 10:2024 categories, providing CWE references and concrete UNSAFE/SAFE code pairs for remediation.

## When to Use

- When the user asks to "audit mobile security", "review mobile app code", or "check for mobile vulnerabilities"
- When the user mentions "OWASP Mobile Top 10", "mobile pentest", or "mobile app security review"
- When scanning Android projects (Kotlin/Java with `AndroidManifest.xml`, `build.gradle`)
- When scanning iOS projects (Swift/Objective-C with `Info.plist`, `.xcodeproj`)
- When reviewing React Native or Flutter projects for mobile-specific security issues
- When a pull request modifies authentication, data storage, network communication, or cryptographic code in a mobile app
- When the user asks about "insecure data storage", "certificate pinning", "root/jailbreak detection", or "WebView security"

## When NOT to Use

- When the user is asking about server-side/backend security (use `security-review` or `bandit-sast`)
- When the user wants runtime dynamic analysis of a running mobile app (use a DAST tool)
- When reviewing general web application code unrelated to mobile platforms
- When the `crypto-audit` skill already covers the request at a cryptographic level
- When auditing container security or infrastructure (use `docker-scout-scanner` or `iac-scanner`)
- When the user asks about **server-side API security, REST endpoints, or backend code** — you **MUST** decline and recommend `api-security-tester` or `security-review`
- When the user asks about **OWASP Web Top 10 issues** (SQL injection, XSS, CSRF) — you **MUST** decline, explain that this skill covers OWASP Mobile Top 10:2024 only, and recommend `security-review`

## Prerequisites

### Tool Installed (Preferred)

No external tool required. This skill uses code analysis only.

All checks are performed through pattern matching and code inspection -- no CLI tool needs to be installed, configured, or invoked.

### Tool Not Installed (Fallback)

This skill is always available as a pure analysis skill. There is no fallback mode because there is no external tool dependency. All checks run directly through code analysis.

## Workflow

1. **Detect project platform** -- Inspect project files to determine which mobile platforms are in use:
   - Android: `AndroidManifest.xml`, `build.gradle`, `*.kt`, `*.java`
   - iOS: `Info.plist`, `*.xcodeproj`, `*.swift`, `*.m`, `*.h`
   - React Native: `package.json` with `react-native`, `*.tsx`/`*.jsx`
   - Flutter: `pubspec.yaml` with `flutter`, `*.dart`
2. **Identify security-relevant files** -- Search for files that handle:
   - Authentication and credential management
   - Data storage (SharedPreferences, UserDefaults, Keychain, SQLite)
   - Network communication (HTTP clients, WebSocket, certificate pinning)
   - WebView configurations
   - Cryptographic operations
   - Intent/deep-link handling
   - Logging and debugging
   - Binary protections and code obfuscation configuration
3. **Run the 10 OWASP Mobile Top 10:2024 checks** against each identified file (see Checks section below).
4. **For each finding:**
   a. Determine severity (Critical / High / Medium / Low) using the Reference Tables
   b. Map to the relevant CWE identifier
   c. Map to the relevant OWASP Mobile Top 10:2024 category
   d. Record file path and line number
   e. Generate the UNSAFE pattern found and the corresponding SAFE fix
   f. Draft a remediation recommendation
5. **Deduplicate and sort** findings by severity: Critical > High > Medium > Low.
6. **Generate the findings report** using the Findings Format below.
7. **Summarize** -- State total findings, breakdown by severity, and top 3 remediation priorities.

## Checks

### Check 1: Improper Credential Usage (M1)

**CWE-798** (Use of Hard-coded Credentials) | **M1** - Improper Credential Usage | Severity: **Critical**

**WHY:** Hardcoded API keys, passwords, and tokens in mobile app source code are trivially extractable through reverse engineering. Unlike server-side code, mobile binaries are distributed to end users, making any embedded secret effectively public. Attackers routinely decompile APKs and IPAs to harvest credentials.

**UNSAFE:**

```kotlin
// Kotlin Android -- hardcoded API key in source
class ApiClient {
    companion object {
        private const val API_KEY = "sk-live-a1b2c3d4e5f6g7h8i9j0"
        private const val API_SECRET = "super_secret_key_12345"
    }

    fun makeRequest() {
        val connection = URL("https://api.example.com").openConnection()
        connection.setRequestProperty("Authorization", "Bearer $API_KEY")
    }
}
```

```swift
// Swift iOS -- hardcoded credentials
class NetworkManager {
    let apiKey = "HARDCODED_GOOGLE_API_KEY_EXAMPLE"
    let secretToken = "HARDCODED_TOKEN_DO_NOT_COMMIT"

    func authenticate() {
        let headers = ["X-API-Key": apiKey]
    }
}
```

```dart
// Flutter -- hardcoded keys in Dart source
class Config {
  static const String apiKey = 'HARDCODED_API_KEY_DO_NOT_DO_THIS';
  static const String dbPassword = 'production_password_123';
}
```

**SAFE:**

```kotlin
// Load credentials from secure sources at runtime
class ApiClient(private val context: Context) {
    private fun getApiKey(): String {
        // Option 1: BuildConfig from local.properties (not committed to VCS)
        return BuildConfig.API_KEY
        // Option 2: Android Keystore for sensitive credentials
        // Option 3: Fetch from server after authentication
    }
}
```

```swift
// Use Keychain or server-side token exchange
class NetworkManager {
    func getApiKey() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "apiKey",
            kSecReturnData as String: true
        ]
        var result: AnyObject?
        SecItemCopyMatching(query as CFDictionary, &result)
        return (result as? Data).flatMap { String(data: $0, encoding: .utf8) }
    }
}
```

---

### Check 2: Inadequate Supply Chain Security (M2)

**CWE-829** (Inclusion of Functionality from Untrusted Control Sphere) | **M2** - Inadequate Supply Chain Security | Severity: **High**

**WHY:** Mobile apps depend on third-party SDKs, libraries, and build tools. Compromised or outdated dependencies can introduce malware, data exfiltration, or known vulnerabilities into the app. Supply chain attacks targeting mobile SDKs (e.g., ad networks, analytics) have been documented in production apps on both app stores.

**UNSAFE:**

```kotlin
// build.gradle.kts -- no dependency verification, wildcard versions
dependencies {
    implementation("com.unknown.sdk:analytics:+")  // Wildcard version
    implementation("com.github.random-user:crypto-lib:1.0")  // Unvetted source
    implementation("com.squareup.okhttp3:okhttp:3.12.0")  // Known vulnerable version
}
```

```dart
// pubspec.yaml -- unvetted dependencies, no version pinning
dependencies:
  flutter:
    sdk: flutter
  sketchy_analytics: any
  http: ^0.13.0
  untrusted_crypto:
    git:
      url: https://github.com/random-user/untrusted_crypto.git
```

**SAFE:**

```kotlin
// build.gradle.kts -- pinned versions, verified sources, dependency verification
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")  // Pinned, patched version
    implementation("com.google.android.gms:play-services-auth:21.0.0")  // Verified publisher
}

// Enable Gradle dependency verification
// In gradle/verification-metadata.xml -- enforce checksums
```

```dart
// pubspec.yaml -- pinned versions, trusted sources only
dependencies:
  flutter:
    sdk: flutter
  http: 1.2.0  // Exact version pin
  dio: 5.4.0   // Well-maintained, audited library
```

---

### Check 3: Insecure Authentication/Authorization (M3)

**CWE-287** (Improper Authentication) | **M3** - Insecure Authentication/Authorization | Severity: **Critical**

**WHY:** Mobile apps often implement client-side authentication checks that can be bypassed by an attacker with a debugger or modified binary. Storing session tokens insecurely, failing to validate tokens server-side, or using biometric authentication without a server-side fallback leaves the app vulnerable to unauthorized access.

**UNSAFE:**

```kotlin
// Kotlin Android -- client-side only auth check
class AuthManager(private val context: Context) {
    fun isAuthenticated(): Boolean {
        // Client-side check only -- trivially bypassed
        val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
        return prefs.getBoolean("is_logged_in", false)
    }

    fun login(username: String, password: String) {
        // Storing credentials in plain SharedPreferences
        val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)
        prefs.edit().putString("username", username).apply()
        prefs.edit().putString("password", password).apply()
        prefs.edit().putBoolean("is_logged_in", true).apply()
    }
}
```

```swift
// Swift iOS -- biometric auth without server-side validation
func authenticateUser() {
    let context = LAContext()
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                           localizedReason: "Authenticate") { success, _ in
        if success {
            // No server-side token validation -- bypass with Frida
            self.grantAccess()
        }
    }
}
```

**SAFE:**

```kotlin
// Server-validated auth with secure token storage
class AuthManager(private val context: Context) {
    private val encryptedPrefs = EncryptedSharedPreferences.create(
        "secure_auth",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        context,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    suspend fun isAuthenticated(): Boolean {
        val token = encryptedPrefs.getString("access_token", null) ?: return false
        // Always validate token server-side
        return apiService.validateToken(token).isValid
    }
}
```

```swift
// Biometric auth backed by Keychain and server validation
func authenticateUser() {
    let context = LAContext()
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                           localizedReason: "Authenticate") { success, _ in
        if success {
            // Retrieve Keychain-stored token and validate with server
            guard let token = KeychainHelper.getToken("access_token") else { return }
            self.apiService.validateToken(token) { isValid in
                if isValid { self.grantAccess() }
            }
        }
    }
}
```

---

### Check 4: Insufficient Input/Output Validation (M4)

**CWE-79** (Improper Neutralization of Input During Web Page Generation) | **M4** - Insufficient Input/Output Validation | Severity: **High**

**WHY:** Mobile apps that use WebViews, deep links, or inter-process communication (Intents, URL schemes) without proper input validation are vulnerable to injection attacks. Malicious input through deep links can trigger XSS in WebViews, SQL injection in local databases, or path traversal in file operations.

**UNSAFE:**

```kotlin
// Kotlin Android -- WebView with JavaScript injection via Intent
class WebViewActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.allowFileAccess = true
        webView.settings.allowUniversalAccessFromFileURLs = true

        // Loading URL directly from intent without validation
        val url = intent.getStringExtra("url") ?: ""
        webView.loadUrl(url)  // Arbitrary URL loading -- XSS, phishing
    }
}
```

```swift
// Swift iOS -- unvalidated deep link handling
func application(_ app: UIApplication, open url: URL,
                 options: [UIApplication.OpenURLOptionsKey: Any]) -> Bool {
    // No validation of URL scheme or parameters
    let webView = WKWebView()
    webView.load(URLRequest(url: url))  // Arbitrary URL loading
    return true
}
```

```dart
// Flutter -- SQL injection in local database
Future<User?> getUser(String username) async {
  final db = await database;
  // String interpolation in SQL -- injection vulnerability
  final result = await db.rawQuery(
    "SELECT * FROM users WHERE username = '$username'"
  );
  return result.isNotEmpty ? User.fromMap(result.first) : null;
}
```

**SAFE:**

```kotlin
// Validate and sanitize all external input
class WebViewActivity : AppCompatActivity() {
    private val allowedHosts = setOf("app.example.com", "cdn.example.com")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowUniversalAccessFromFileURLs = false

        val url = intent.getStringExtra("url") ?: return
        val uri = Uri.parse(url)
        if (uri.scheme == "https" && uri.host in allowedHosts) {
            webView.loadUrl(url)
        }
    }
}
```

```dart
// Use parameterized queries
Future<User?> getUser(String username) async {
  final db = await database;
  final result = await db.query(
    'users',
    where: 'username = ?',
    whereArgs: [username],
  );
  return result.isNotEmpty ? User.fromMap(result.first) : null;
}
```

---

### Check 5: Insecure Communication (M5)

**CWE-295** (Improper Certificate Validation) | **M5** - Insecure Communication | Severity: **Critical**

**WHY:** Mobile apps frequently communicate over untrusted networks (public Wi-Fi, cellular). Without certificate pinning and proper TLS configuration, attackers can perform man-in-the-middle attacks to intercept credentials, session tokens, and sensitive data. Disabling certificate validation or ATS is a common developer shortcut that destroys transport security.

**UNSAFE:**

```kotlin
// Kotlin Android -- trust all certificates
val trustAllCerts = arrayOf<TrustManager>(object : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
})

val sslContext = SSLContext.getInstance("TLS")
sslContext.init(null, trustAllCerts, SecureRandom())
OkHttpClient.Builder().sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
```

```swift
// Swift iOS -- disabling ATS entirely in Info.plist
// <key>NSAppTransportSecurity</key>
// <dict>
//     <key>NSAllowsArbitraryLoads</key>
//     <true/>
// </dict>

// Swift -- disabling server trust evaluation
class InsecureDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // Accept any certificate
        completionHandler(.useCredential,
                          URLCredential(trust: challenge.protectionSpace.serverTrust!))
    }
}
```

```typescript
// React Native -- cleartext traffic
fetch('http://api.example.com/login', {
  method: 'POST',
  body: JSON.stringify({ username, password }),
});
```

**SAFE:**

```kotlin
// Kotlin Android -- certificate pinning with OkHttp
val certificatePinner = CertificatePinner.Builder()
    .add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .add("api.example.com", "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=")  // Backup pin
    .build()

val client = OkHttpClient.Builder()
    .certificatePinner(certificatePinner)
    .build()
```

```swift
// Swift iOS -- certificate pinning with URLSession
class PinningDelegate: NSObject, URLSessionDelegate {
    let pinnedCertificates: Set<Data> = {
        let url = Bundle.main.url(forResource: "api-cert", withExtension: "cer")!
        return [try! Data(contentsOf: url)]
    }()

    func urlSession(_ session: URLSession,
                    didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard let serverTrust = challenge.protectionSpace.serverTrust,
              let serverCert = SecTrustGetCertificateAtIndex(serverTrust, 0) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let serverCertData = SecCertificateCopyData(serverCert) as Data
        if pinnedCertificates.contains(serverCertData) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
```

---

### Check 6: Inadequate Privacy Controls (M6)

**CWE-359** (Exposure of Private Personal Information) | **M6** - Inadequate Privacy Controls | Severity: **High**

**WHY:** Mobile apps collect extensive personal data (location, contacts, photos, health data). Logging PII, failing to anonymize analytics, sharing data with third-party SDKs without consent, or retaining data beyond its purpose violates privacy regulations (GDPR, CCPA) and exposes users to identity theft if the data is leaked.

**UNSAFE:**

```kotlin
// Kotlin Android -- logging PII
class UserService {
    fun processLogin(email: String, password: String, ssn: String) {
        Log.d("AUTH", "Login attempt: email=$email, password=$password, ssn=$ssn")
        analytics.track("login", mapOf(
            "email" to email,
            "device_id" to Settings.Secure.ANDROID_ID,
            "location" to lastKnownLocation.toString()
        ))
    }
}
```

```swift
// Swift iOS -- sending PII to analytics without consent
func trackUserActivity(user: User) {
    Analytics.shared.track("user_active", properties: [
        "full_name": user.fullName,
        "email": user.email,
        "phone": user.phoneNumber,
        "location": "\(user.latitude),\(user.longitude)"
    ])
    // No consent check, no anonymization
}
```

**SAFE:**

```kotlin
// Anonymize data before logging or analytics
class UserService {
    fun processLogin(email: String, password: String) {
        Log.d("AUTH", "Login attempt for user hash: ${email.sha256()}")
        if (consentManager.hasAnalyticsConsent()) {
            analytics.track("login", mapOf(
                "user_hash" to email.sha256(),
                "timestamp" to System.currentTimeMillis()
            ))
        }
    }

    private fun String.sha256(): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
```

```swift
// Privacy-respecting analytics with consent
func trackUserActivity(user: User) {
    guard ConsentManager.shared.hasConsent(for: .analytics) else { return }
    Analytics.shared.track("user_active", properties: [
        "user_hash": user.email.sha256(),
        "session_id": SessionManager.shared.currentSessionId
        // No PII, no location unless explicitly consented
    ])
}
```

---

### Check 7: Insufficient Binary Protections (M7)

**CWE-693** (Protection Mechanism Failure) | **M7** - Insufficient Binary Protections | Severity: **Medium**

**WHY:** Mobile binaries are distributed to end users who can reverse-engineer, modify, and redistribute them. Without code obfuscation, root/jailbreak detection, tamper detection, and debugger detection, attackers can analyze business logic, bypass license checks, extract secrets, and create modified versions of the app.

**UNSAFE:**

```kotlin
// Kotlin Android -- no ProGuard/R8, no tamper detection
// build.gradle
// minifyEnabled = false  // No obfuscation
// shrinkResources = false

class LicenseManager {
    fun isPremiumUser(): Boolean {
        // Easily patched by changing return value
        val prefs = getSharedPreferences("license", MODE_PRIVATE)
        return prefs.getBoolean("premium", false)
    }
    // No root detection, no debugger detection, no integrity checks
}
```

```swift
// Swift iOS -- no jailbreak detection, no debugger check
class AppSecurity {
    // Missing: jailbreak detection
    // Missing: debugger detection
    // Missing: code signature validation
    func startApp() {
        // App starts without any integrity checks
        loadMainScreen()
    }
}
```

**SAFE:**

```kotlin
// Android -- enable obfuscation and add runtime checks
// build.gradle
// minifyEnabled = true
// shrinkResources = true
// proguardFiles getDefaultProguardFile('proguard-android-optimize.txt')

class SecurityChecks(private val context: Context) {
    fun isDeviceCompromised(): Boolean {
        return isRooted() || isDebugged() || isTampered()
    }

    private fun isRooted(): Boolean {
        val rootPaths = listOf("/system/app/Superuser.apk", "/system/xbin/su", "/sbin/su")
        return rootPaths.any { File(it).exists() }
            || Build.TAGS?.contains("test-keys") == true
    }

    private fun isDebugged(): Boolean {
        return Debug.isDebuggerConnected()
            || (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }

    private fun isTampered(): Boolean {
        val expectedSignature = "expected_signature_hash"
        val pm = context.packageManager
        val sig = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
        return sig.signatures[0].toCharsString() != expectedSignature
    }
}
```

```swift
// Swift iOS -- jailbreak and debugger detection
class AppSecurity {
    static func isJailbroken() -> Bool {
        let jailbreakPaths = [
            "/Applications/Cydia.app",
            "/Library/MobileSubstrate/MobileSubstrate.dylib",
            "/usr/sbin/sshd",
            "/usr/bin/ssh",
            "/private/var/lib/apt/"
        ]
        for path in jailbreakPaths {
            if FileManager.default.fileExists(atPath: path) { return true }
        }
        // Check if app can write outside sandbox
        let testPath = "/private/jailbreak_test"
        do {
            try "test".write(toFile: testPath, atomically: true, encoding: .utf8)
            try FileManager.default.removeItem(atPath: testPath)
            return true
        } catch { return false }
    }

    static func isDebuggerAttached() -> Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        sysctl(&mib, 4, &info, &size, nil, 0)
        return (info.kp_proc.p_flag & P_TRACED) != 0
    }
}
```

---

### Check 8: Security Misconfiguration (M8)

**CWE-276** (Incorrect Default Permissions) | **M8** - Security Misconfiguration | Severity: **High**

**WHY:** Insecure default settings in mobile apps -- exported components without permissions, debug mode enabled in production, backup allowed, cleartext traffic permitted -- create attack surfaces that require no sophisticated exploitation. Attackers can interact with exported Activities/Services, extract app data from backups, or intercept cleartext traffic.

**UNSAFE:**

```xml
<!-- Android AndroidManifest.xml -- insecure configuration -->
<application
    android:debuggable="true"
    android:allowBackup="true"
    android:usesCleartextTraffic="true">

    <!-- Exported activity without permission -->
    <activity android:name=".AdminActivity"
              android:exported="true" />

    <!-- Exported content provider without permission -->
    <provider android:name=".UserDataProvider"
              android:exported="true"
              android:authorities="com.example.provider" />

    <!-- Exported broadcast receiver -->
    <receiver android:name=".PaymentReceiver"
              android:exported="true" />
</application>
```

```swift
// Swift iOS -- insecure configuration
// Info.plist with NSAllowsArbitraryLoads = true
// App does not set appropriate data protection class
class FileStorage {
    func saveToken(_ token: String) {
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = path.appendingPathComponent("token.txt")
        // No file protection attribute set
        try? token.write(to: file, atomically: true, encoding: .utf8)
    }
}
```

**SAFE:**

```xml
<!-- Android AndroidManifest.xml -- secure configuration -->
<application
    android:debuggable="false"
    android:allowBackup="false"
    android:usesCleartextTraffic="false"
    android:networkSecurityConfig="@xml/network_security_config">

    <!-- Internal-only activity -->
    <activity android:name=".AdminActivity"
              android:exported="false" />

    <!-- Protected content provider -->
    <provider android:name=".UserDataProvider"
              android:exported="false"
              android:authorities="com.example.provider" />
</application>
```

```swift
// Swift iOS -- secure file storage with data protection
class FileStorage {
    func saveToken(_ token: String) throws {
        let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = path.appendingPathComponent("token.txt")
        try token.write(to: file, atomically: true, encoding: .utf8)
        // Set complete protection -- file inaccessible when device is locked
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: file.path
        )
    }
}
```

---

### Check 9: Insecure Data Storage (M9)

**CWE-312** (Cleartext Storage of Sensitive Information) | **M9** - Insecure Data Storage | Severity: **Critical**

**WHY:** Mobile devices are frequently lost, stolen, or accessed by malware. Storing sensitive data (credentials, tokens, PII, financial data) in plaintext on the file system, in SharedPreferences/UserDefaults, or in unencrypted databases makes it trivially accessible to any app or attacker with physical/root access to the device.

**UNSAFE:**

```kotlin
// Kotlin Android -- storing sensitive data in plain SharedPreferences
class TokenStorage(context: Context) {
    private val prefs = context.getSharedPreferences("tokens", Context.MODE_PRIVATE)

    fun saveAuthToken(token: String) {
        prefs.edit().putString("auth_token", token).apply()
    }

    fun saveUserData(name: String, ssn: String, creditCard: String) {
        prefs.edit()
            .putString("name", name)
            .putString("ssn", ssn)
            .putString("credit_card", creditCard)
            .apply()
    }
}
```

```swift
// Swift iOS -- storing secrets in UserDefaults
class CredentialStore {
    func saveCredentials(username: String, password: String) {
        UserDefaults.standard.set(username, forKey: "username")
        UserDefaults.standard.set(password, forKey: "password")
        UserDefaults.standard.set("sk-live-abc123", forKey: "api_key")
    }
}
```

```dart
// Flutter -- storing sensitive data in shared_preferences
import 'package:shared_preferences/shared_preferences.dart';

Future<void> saveToken(String token) async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setString('auth_token', token);
  await prefs.setString('refresh_token', refreshToken);
  await prefs.setString('pin_code', pinCode);
}
```

**SAFE:**

```kotlin
// Kotlin Android -- EncryptedSharedPreferences
class TokenStorage(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context, "secure_tokens", masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun saveAuthToken(token: String) {
        prefs.edit().putString("auth_token", token).apply()
    }
}
```

```swift
// Swift iOS -- Keychain storage
class CredentialStore {
    func saveCredentials(username: String, password: String) throws {
        let passwordData = password.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: username,
            kSecValueData as String: passwordData,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.saveFailed(status) }
    }
}
```

```dart
// Flutter -- flutter_secure_storage (uses Keychain/Keystore)
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

final storage = FlutterSecureStorage();

Future<void> saveToken(String token) async {
  await storage.write(key: 'auth_token', value: token);
}
```

---

### Check 10: Insufficient Cryptography (M10)

**CWE-327** (Use of a Broken or Risky Cryptographic Algorithm) | **M10** - Insufficient Cryptography | Severity: **High**

**WHY:** Mobile apps that roll custom encryption, use deprecated algorithms (MD5, DES, RC4), or misuse cryptographic primitives (ECB mode, static IVs, hardcoded keys) provide a false sense of security. Data "encrypted" with broken crypto is effectively plaintext to a motivated attacker.

**UNSAFE:**

```kotlin
// Kotlin Android -- weak cryptography
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

class CryptoHelper {
    // Hardcoded key
    private val KEY = "1234567890abcdef".toByteArray()

    fun encrypt(data: String): ByteArray {
        // DES with ECB mode
        val cipher = Cipher.getInstance("DES/ECB/PKCS5Padding")
        val keySpec = SecretKeySpec(KEY, "DES")
        cipher.init(Cipher.ENCRYPT_MODE, keySpec)
        return cipher.doFinal(data.toByteArray())
    }
}
```

```swift
// Swift iOS -- insecure hashing for passwords
import CommonCrypto

func hashPassword(_ password: String) -> String {
    // MD5 for password hashing -- broken
    let data = password.data(using: .utf8)!
    var digest = [UInt8](repeating: 0, count: Int(CC_MD5_DIGEST_LENGTH))
    data.withUnsafeBytes { CC_MD5($0.baseAddress, CC_LONG(data.count), &digest) }
    return digest.map { String(format: "%02x", $0) }.joined()
}
```

```dart
// Flutter -- weak encryption
import 'package:encrypt/encrypt.dart' as encrypt;

String encryptData(String plaintext) {
  final key = encrypt.Key.fromUtf8('my16charpassword');  // Hardcoded key
  final iv = encrypt.IV.fromLength(0);  // Zero IV
  final encrypter = encrypt.Encrypter(encrypt.AES(key, mode: encrypt.AESMode.ecb));
  return encrypter.encrypt(plaintext, iv: iv).base64;
}
```

**SAFE:**

```kotlin
// Kotlin Android -- proper cryptography with Android Keystore
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

class CryptoHelper {
    private val keyAlias = "app_encryption_key"

    init {
        if (!keyExists()) generateKey()
    }

    private fun generateKey() {
        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
        )
        keyGenerator.init(
            KeyGenParameterSpec.Builder(keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        keyGenerator.generateKey()
    }

    fun encrypt(data: ByteArray): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getKey())
        return Pair(cipher.iv, cipher.doFinal(data))
    }
}
```

```swift
// Swift iOS -- CryptoKit for modern encryption
import CryptoKit

func encryptData(_ data: Data, using key: SymmetricKey) throws -> Data {
    let sealedBox = try AES.GCM.seal(data, using: key)
    return sealedBox.combined!
}

func hashPassword(_ password: String) -> String {
    // Use bcrypt or Argon2 for passwords, SHA-256 only for non-password hashing
    let data = Data(password.utf8)
    let hash = SHA256.hash(data: data)
    return hash.compactMap { String(format: "%02x", $0) }.joined()
}
```

---

## Findings Format

Each finding should include:

| Field | Description |
|-------|-------------|
| Severity | Critical / High / Medium / Low |
| CWE | CWE-XXX identifier |
| OWASP Mobile | M1-M10 category (OWASP Mobile Top 10:2024) |
| Platform | Android / iOS / React Native / Flutter / Cross-platform |
| Location | file:line |
| Issue | Description of the vulnerability |
| Remediation | How to fix it |

### Example Finding

| Field | Value |
|-------|-------|
| Severity | Critical |
| CWE | CWE-312 |
| OWASP Mobile | M9 - Insecure Data Storage |
| Platform | Android |
| Location | app/src/main/java/com/example/TokenStorage.kt:12 |
| Issue | Auth token stored in plain SharedPreferences without encryption |
| Remediation | Use EncryptedSharedPreferences with AES256-GCM or store in Android Keystore |

## Reference Tables

### Mobile Check to CWE/OWASP Mapping

| # | Check | CWE | OWASP Mobile | Default Severity |
|---|-------|-----|--------------|------------------|
| 1 | Hardcoded credentials in source | CWE-798 | M1 - Improper Credential Usage | Critical |
| 2 | Unvetted/vulnerable dependencies | CWE-829 | M2 - Inadequate Supply Chain Security | High |
| 3 | Client-side auth bypass / insecure session | CWE-287 | M3 - Insecure Authentication/Authorization | Critical |
| 4 | WebView injection / unvalidated deep links | CWE-79 | M4 - Insufficient Input/Output Validation | High |
| 5 | Missing certificate pinning / disabled TLS | CWE-295 | M5 - Insecure Communication | Critical |
| 6 | PII in logs / uncontrolled data sharing | CWE-359 | M6 - Inadequate Privacy Controls | High |
| 7 | No obfuscation / missing tamper detection | CWE-693 | M7 - Insufficient Binary Protections | Medium |
| 8 | Exported components / debug mode in prod | CWE-276 | M8 - Security Misconfiguration | High |
| 9 | Plaintext storage of tokens/credentials | CWE-312 | M9 - Insecure Data Storage | Critical |
| 10 | Weak/broken crypto algorithms | CWE-327 | M10 - Insufficient Cryptography | High |
| 11 | SQL injection in local databases | CWE-89 | M4 - Insufficient Input/Output Validation | High |
| 12 | Insecure random number generation | CWE-330 | M10 - Insufficient Cryptography | High |
| 13 | Disabled certificate validation | CWE-295 | M5 - Insecure Communication | Critical |
| 14 | Cleartext HTTP communication | CWE-319 | M5 - Insecure Communication | High |
| 15 | Sensitive data in clipboard/pasteboard | CWE-200 | M9 - Insecure Data Storage | Medium |

### OWASP Mobile Top 10:2024 Quick Reference

| Category | Description | Related Checks |
|----------|-------------|----------------|
| M1 | Improper Credential Usage | Check 1 |
| M2 | Inadequate Supply Chain Security | Check 2 |
| M3 | Insecure Authentication/Authorization | Check 3 |
| M4 | Insufficient Input/Output Validation | Checks 4, 11 |
| M5 | Insecure Communication | Checks 5, 13, 14 |
| M6 | Inadequate Privacy Controls | Check 6 |
| M7 | Insufficient Binary Protections | Check 7 |
| M8 | Security Misconfiguration | Check 8 |
| M9 | Insecure Data Storage | Checks 9, 15 |
| M10 | Insufficient Cryptography | Checks 10, 12 |

### CWE Reference

| CWE ID | Name | MITRE URL |
|--------|------|-----------|
| CWE-79 | Improper Neutralization of Input During Web Page Generation | https://cwe.mitre.org/data/definitions/79.html |
| CWE-89 | Improper Neutralization of Special Elements used in an SQL Command | https://cwe.mitre.org/data/definitions/89.html |
| CWE-200 | Exposure of Sensitive Information to an Unauthorized Actor | https://cwe.mitre.org/data/definitions/200.html |
| CWE-276 | Incorrect Default Permissions | https://cwe.mitre.org/data/definitions/276.html |
| CWE-287 | Improper Authentication | https://cwe.mitre.org/data/definitions/287.html |
| CWE-295 | Improper Certificate Validation | https://cwe.mitre.org/data/definitions/295.html |
| CWE-312 | Cleartext Storage of Sensitive Information | https://cwe.mitre.org/data/definitions/312.html |
| CWE-319 | Cleartext Transmission of Sensitive Information | https://cwe.mitre.org/data/definitions/319.html |
| CWE-327 | Use of a Broken or Risky Cryptographic Algorithm | https://cwe.mitre.org/data/definitions/327.html |
| CWE-330 | Use of Insufficiently Random Values | https://cwe.mitre.org/data/definitions/330.html |
| CWE-359 | Exposure of Private Personal Information | https://cwe.mitre.org/data/definitions/359.html |
| CWE-693 | Protection Mechanism Failure | https://cwe.mitre.org/data/definitions/693.html |
| CWE-798 | Use of Hard-coded Credentials | https://cwe.mitre.org/data/definitions/798.html |
| CWE-829 | Inclusion of Functionality from Untrusted Control Sphere | https://cwe.mitre.org/data/definitions/829.html |

## Example Usage

**User prompt:**
> "Run a mobile security audit on this Android project"

**Expected output (abbreviated):**

```text
## Mobile Security Audit Results

Scanned 24 files across Android (Kotlin/Java)

### Findings (8 total: 3 Critical, 3 High, 2 Medium)

| # | Severity | CWE | OWASP Mobile | Platform | Location | Issue |
|---|----------|-----|--------------|----------|----------|-------|
| 1 | Critical | CWE-798 | M1 | Android | src/ApiClient.kt:5 | API key hardcoded as string constant |
| 2 | Critical | CWE-312 | M9 | Android | src/TokenStorage.kt:12 | Auth token in plain SharedPreferences |
| 3 | Critical | CWE-295 | M5 | Android | src/NetworkClient.kt:8 | TrustAllCerts manager disables certificate validation |
| 4 | High | CWE-276 | M8 | Android | AndroidManifest.xml:3 | android:debuggable="true" in production build |
| 5 | High | CWE-79 | M4 | Android | src/WebViewActivity.kt:15 | WebView loads URL from intent without validation |
| 6 | High | CWE-327 | M10 | Android | src/CryptoHelper.kt:9 | DES/ECB encryption with hardcoded key |
| 7 | Medium | CWE-693 | M7 | Android | build.gradle:18 | ProGuard/R8 obfuscation disabled |
| 8 | Medium | CWE-359 | M6 | Android | src/UserService.kt:22 | Password logged in plaintext via Log.d() |

### Recommendations
1. Remove all hardcoded API keys; use BuildConfig or Android Keystore (Finding #1)
2. Replace SharedPreferences with EncryptedSharedPreferences for tokens (Finding #2)
3. Implement certificate pinning with OkHttp CertificatePinner (Finding #3)
```

## Provenance

- Source repo: https://github.com/kalshamsi/claude-security-skills
- Original path: skills/mobile-security/SKILL.md
- License: unknown - see repo
- 并入说明（2026-09-07）：下载并归一为单文件（frontmatter 仅 name/description）；原仓库配套技能/辅助文件未随附，需要时回上游取用。
- Integration note (2026-09-07): fetched and normalized to single-file; sibling skills and auxiliary files of the source repo are not bundled - see upstream.
