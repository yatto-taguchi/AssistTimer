import ExpoModulesCore

// ★ iOS 26 の AlarmKit（純正アラーム）を JS から使うための Expo モジュール
// 実処理は AlarmKitBridge.swift に分離（Expo に依存せず型チェックできるようにするため）
public class ExpoAlarmKitModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoAlarmKit")

    Function("isAvailable") { () -> Bool in
      return AlarmKitBridge.isAvailable()
    }

    Function("getAuthorizationStatus") { () -> String in
      return AlarmKitBridge.authorizationStatus()
    }

    AsyncFunction("requestAuthorization") { () async -> String in
      return await AlarmKitBridge.requestAuthorization()
    }

    AsyncFunction("schedule") { (key: String, timestampMs: Double, title: String, soundOn: Bool) async -> String in
      return await AlarmKitBridge.schedule(key: key, timestampMs: timestampMs, title: title, soundOn: soundOn)
    }

    Function("cancel") { (key: String) -> Bool in
      return AlarmKitBridge.cancel(key: key)
    }

    // ユーザーがアラーム画面で「停止」した予約を取り出す（[{ key, timestamp }]）
    Function("takeUserStoppedAlarms") { () -> [[String: Any]] in
      return AlarmKitBridge.takeUserStoppedAlarms()
    }
  }
}
