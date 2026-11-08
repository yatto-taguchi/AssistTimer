import React, { useContext, useState, useEffect } from 'react';
import { View, StyleSheet, Platform, Text, AppState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppContext } from '../utils/AppContext';

// ネイティブモジュールが読み込めない環境（Webやモック等）での安全ガード
let BannerAd = null;
let BannerAdSize = null;
let TestIds = null;

try {
  const GoogleMobileAds = require('react-native-google-mobile-ads');
  BannerAd = GoogleMobileAds.BannerAd;
  BannerAdSize = GoogleMobileAds.BannerAdSize;
  TestIds = GoogleMobileAds.TestIds;
} catch (e) {
  // ネイティブモジュールが存在しない環境
}

// 本番用バナー広告ユニットID（AdMob管理画面で発行されたユニットID）
const PROD_BANNER_AD_UNIT_ID = Platform.select({
  ios: 'ca-app-pub-3646959221255515/9534675780',
  android: 'ca-app-pub-3940256099942544/6300978111',
  default: 'ca-app-pub-3646959221255515/9534675780',
});

// 開発環境（__DEV__）ではポリシー違反（無効トラフィック）防止のため公式テストIDを使用
// 本番ビルド（TestFlight / App Store公開版）では本番Ad Unit IDを使用
const AD_UNIT_ID = __DEV__
  ? (TestIds ? TestIds.BANNER : 'ca-app-pub-3940256099942544/2934735716')
  : PROD_BANNER_AD_UNIT_ID;

export default function AdBannerComponent({ style }) {
  const { isProMode, isEcoMode } = useContext(AppContext);
  const [hasEnteredForeground, setHasEnteredForeground] = useState(
    () => !AppState.currentState || AppState.currentState === 'active'
  );
  let insets = { bottom: 0 };
  try {
    insets = useSafeAreaInsets();
  } catch (e) {
    // Provider外等の安全フォールバック
  }

  useEffect(() => {
    if (hasEnteredForeground) return undefined;
    if (!AppState.currentState || AppState.currentState === 'active') {
      setHasEnteredForeground(true);
      return undefined;
    }
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        setHasEnteredForeground(true);
        sub.remove();
      }
    });
    return () => {
      sub.remove();
    };
  }, [hasEnteredForeground]);

  // ホームバー（セーフエリア下部）との干渉・誤タップを防ぐクリアランス
  const bottomPadding = Math.max(insets.bottom, 4);

  // Proモード加入中は広告を一切レンダリングしない
  if (isProMode) {
    return null;
  }

  // バックグラウンドでのコールド起動中（iPhoneロック中にWCSession等で裏側起床し、まだ一度も画面が開かれていない状態）は
  // WKWebView / GPU 初期化によるクラッシュを防ぐため BannerAd をマウントせずプレースホルダー領域のみ保持する
  if (!hasEnteredForeground) {
    return (
      <View
        style={[
          styles.container,
          { minHeight: 50, backgroundColor: isEcoMode ? '#000' : '#F2F2F7', paddingBottom: bottomPadding },
          style,
        ]}
      />
    );
  }

  // ライブラリがロードできない環境でのフォールバック
  if (!BannerAd || !BannerAdSize) {
    return (
      <View style={[styles.fallbackContainer, { backgroundColor: isEcoMode ? '#111' : '#F2F2F7', paddingBottom: bottomPadding }, style]}>
        <Text style={[styles.fallbackText, { color: isEcoMode ? '#666' : '#999' }]}>
          Ad Banner (Test Area)
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isEcoMode ? '#000' : '#F2F2F7', paddingBottom: bottomPadding }, style]}>
      <BannerAd
        unitId={AD_UNIT_ID}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{
          requestNonPersonalizedAdsOnly: true,
        }}
        onAdLoaded={() => {
          console.log('Banner Ad loaded successfully');
        }}
        onAdFailedToLoad={(error) => {
          // 広告読み込み失敗時は静かにログ（UIを破壊しない）
          console.log('Banner Ad failed to load: ', error);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  fallbackContainer: {
    width: '100%',
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#444',
  },
  fallbackText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
