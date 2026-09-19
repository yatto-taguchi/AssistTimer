import React, { useState, useEffect, useContext } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
} from 'react-native';
import { AppContext } from '../utils/AppContext';

// ネイティブPurchasesモジュール
let Purchases = null;
try {
  Purchases = require('react-native-purchases').default;
} catch (e) {
  // ネイティブモジュール未ロード時のフォールバック
}

// Apple標準EULA（利用規約）URL
const TERMS_OF_USE_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
// プライバシーポリシーURL（公式Webサイトの正式なURL）
const PRIVACY_POLICY_URL = 'https://litt-design.jp/wp1/%e5%96%b6%e8%80%85%e6%83%85%e5%a0%b1%e3%81%8a%e3%82%88%e3%81%b3%e3%82%b5%e3%83%9d%e3%83%bc%e3%83%88/';

export default function ProSubscriptionModal({ visible, onClose }) {
  const { isEcoMode, isProMode, setIsProMode } = useContext(AppContext);
  const [loading, setLoading] = useState(false);
  const [packages, setPackages] = useState([]);
  const [selectedPackage, setSelectedPackage] = useState(null);

  // モーダル表示時にOfferings（商品情報）を取得
  useEffect(() => {
    if (visible && Purchases) {
      loadOfferings();
    }
  }, [visible]);

  // RevenueCatが初期化済みかどうか安全に判定
  const isPurchasesReady = async () => {
    if (!Purchases) return false;
    try {
      if (typeof Purchases.isConfigured === 'function') {
        return await Purchases.isConfigured();
      }
    } catch (e) {
      return false;
    }
    return false;
  };

  const loadOfferings = async () => {
    const ready = await isPurchasesReady();
    if (!ready) return;

    try {
      setLoading(true);
      const offerings = await Purchases.getOfferings();
      if (offerings.current && offerings.current.availablePackages.length !== 0) {
        setPackages(offerings.current.availablePackages);
        setSelectedPackage(offerings.current.availablePackages[0]);
      }
    } catch (e) {
      console.log('Error fetching offerings', e);
    } finally {
      setLoading(false);
    }
  };

  // 購入処理
  const handlePurchase = async () => {
    const ready = await isPurchasesReady();

    if (!ready) {
      // APIキー未設定・シミュレーターテスト環境用
      Alert.alert(
        'テスト・シミュレーター環境',
        'RevenueCat APIキーが未設定のため、テスト用シミュレーションとしてProプランを有効化しますか？\n（広告が消え、記録上限が解除されます）',
        [
          { text: 'キャンセル', style: 'cancel' },
          {
            text: '有効化（テスト）',
            onPress: () => {
              setIsProMode(true);
              Alert.alert('Pro有効化', 'Proプランが有効になりました！広告が消え、記録枠が無制限になりました。');
              onClose();
            },
          },
        ]
      );
      return;
    }

    try {
      setLoading(true);
      let purchaseResult;
      if (selectedPackage) {
        purchaseResult = await Purchases.purchasePackage(selectedPackage);
      } else {
        const offerings = await Purchases.getOfferings();
        if (offerings.current?.availablePackages[0]) {
          purchaseResult = await Purchases.purchasePackage(offerings.current.availablePackages[0]);
        } else {
          Alert.alert('エラー', '購入可能なプラン情報を取得できませんでした。時間をおいて再度お試しください。');
          setLoading(false);
          return;
        }
      }

      if (purchaseResult && purchaseResult.customerInfo) {
        const isPro = typeof purchaseResult.customerInfo.entitlements.active['pro'] !== 'undefined' ||
                      typeof purchaseResult.customerInfo.entitlements.active['premium'] !== 'undefined';
        if (isPro) {
          setIsProMode(true);
          Alert.alert('ご購入ありがとうございます！', 'AssistTimer Proが有効化されました。すべての特典をご利用いただけます。');
          onClose();
        } else {
          setIsProMode(true);
          Alert.alert('完了', 'Proプランを有効化しました。');
          onClose();
        }
      }
    } catch (e) {
      if (!e.userCancelled) {
        Alert.alert('購入エラー', e.message || '購入処理中にエラーが発生しました。');
      }
    } finally {
      setLoading(false);
    }
  };

  // 購入の復元（Apple審査必須）
  const handleRestore = async () => {
    const ready = await isPurchasesReady();
    if (!ready) {
      Alert.alert(
        '購入の復元（テスト環境）',
        'テスト環境でのシミュレーションです。Proプランを復元しますか？',
        [
          { text: 'キャンセル', style: 'cancel' },
          {
            text: '復元する',
            onPress: () => {
              setIsProMode(true);
              Alert.alert('復元完了', 'Proプランが正常に復元されました。');
              onClose();
            },
          },
        ]
      );
      return;
    }

    try {
      setLoading(true);
      const customerInfo = await Purchases.restorePurchases();
      const isPro = typeof customerInfo.entitlements.active['pro'] !== 'undefined' ||
                    typeof customerInfo.entitlements.active['premium'] !== 'undefined';
      
      if (isPro) {
        setIsProMode(true);
        Alert.alert('復元完了', '過去の購入履歴が確認され、Proプランが正常に復元されました！');
        onClose();
      } else {
        Alert.alert('復元結果', '有効なProプランの購入履歴が見つかりませんでした。');
      }
    } catch (e) {
      Alert.alert('復元エラー', e.message || '復元処理に失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  const openUrl = async (url) => {
    try {
      await Linking.openURL(url);
    } catch (e) {
      console.log('Error opening URL:', e);
      Alert.alert('エラー', 'リンクを開けませんでした: ' + url);
    }
  };

  // カラー設定
  const bg = isEcoMode ? '#000000' : '#1C1C1E';
  const cardBg = isEcoMode ? '#121212' : '#2C2C2E';
  const text = '#FFFFFF';
  const subText = '#8E8E93';
  const accent = '#007AFF';
  const gold = '#FFD700';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: bg }]}>
        {/* ヘッダー閉じるボタン */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* タイトルバッジ & アプリ紹介 */}
          <View style={styles.heroSection}>
            <View style={[styles.proBadge, { backgroundColor: gold }]}>
              <Text style={styles.proBadgeText}>PRO PLAN</Text>
            </View>
            <Text style={[styles.title, { color: text }]}>AssistTimer Pro</Text>
            <Text style={[styles.subtitle, { color: subText }]}>
              美容師・アシスタントの技術練習を{'\n'}極限まで快適にするプロフェッショナルプラン
            </Text>
          </View>

          {/* 特典カード一覧 */}
          <View style={[styles.featuresCard, { backgroundColor: cardBg }]}>
            <View style={styles.featureRow}>
              <Text style={styles.featureIcon}>🚫</Text>
              <View style={styles.featureTextWrapper}>
                <Text style={[styles.featureTitle, { color: text }]}>広告の完全非表示</Text>
                <Text style={[styles.featureDesc, { color: subText }]}>
                  タイマー画面や記録一覧の広告をすべて排除し、練習に100%集中
                </Text>
              </View>
            </View>

            <View style={styles.featureDivider} />

            <View style={styles.featureRow}>
              <Text style={styles.featureIcon}>📝</Text>
              <View style={styles.featureTextWrapper}>
                <Text style={[styles.featureTitle, { color: text }]}>練習記録の無制限保存</Text>
                <Text style={[styles.featureDesc, { color: subText }]}>
                  無料枠（50件）の上限を解除。日々の成長をずっと蓄積・見返し可能
                </Text>
              </View>
            </View>

            <View style={styles.featureDivider} />

            <View style={styles.featureRow}>
              <Text style={styles.featureIcon}>⚡️</Text>
              <View style={styles.featureTextWrapper}>
                <Text style={[styles.featureTitle, { color: text }]}>今後の新機能への先行アクセス</Text>
                <Text style={[styles.featureDesc, { color: subText }]}>
                  Apple Watch連携や店内タイマー共有機能（v2.0予定）などへ順次対応
                </Text>
              </View>
            </View>
          </View>

          {/* 料金プランカード（Apple審査ガイドライン3.1.2(c)準拠: タイトル・期間・価格明記） */}
          <View style={[styles.planCard, { borderColor: accent, backgroundColor: cardBg }]}>
            <View style={styles.planHeader}>
              <View>
                <Text style={[styles.planName, { color: text }]}>AssistTimer Pro</Text>
                <Text style={{ color: subText, fontSize: 12, marginTop: 2 }}>自動更新サブスクリプション（1ヶ月）</Text>
              </View>
              <View style={[styles.activeTag, { backgroundColor: '#34C759' }]}>
                <Text style={styles.activeTagText}>1ヶ月無料体験</Text>
              </View>
            </View>
            <View style={styles.priceRow}>
              <Text style={[styles.priceCurrency, { color: text }]}>¥</Text>
              <Text style={[styles.priceAmount, { color: text }]}>100</Text>
              <Text style={[styles.pricePeriod, { color: subText }]}> / 1ヶ月（月額自動更新）</Text>
            </View>
            <View style={{ backgroundColor: isEcoMode ? '#1C3A27' : '#E8F5E9', paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8, marginTop: 4, marginBottom: 8 }}>
              <Text style={{ color: '#34C759', fontSize: 13, fontWeight: '700' }}>
                最初の1ヶ月間は ¥0（無料トライアル）
              </Text>
            </View>
            <Text style={[styles.planNote, { color: subText }]}>
              初回1ヶ月無料体験終了後は、月額100円（税込）で自動更新されます。いつでも端末設定から解約可能です。
            </Text>
          </View>

          {/* 加入・購入ボタン */}
          {isProMode ? (
            <View style={[styles.subscribedBanner, { backgroundColor: '#1A3826', borderColor: '#34C759' }]}>
              <Text style={{ color: '#34C759', fontWeight: '700', fontSize: 16 }}>
                ✓ Proプランにご加入中です
              </Text>
            </View>
          ) : (
            <View style={{ width: '100%', alignItems: 'center' }}>
              <TouchableOpacity
                style={[styles.purchaseButton, { backgroundColor: accent }]}
                onPress={handlePurchase}
                disabled={loading}
                activeOpacity={0.8}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.purchaseButtonText}>まずは1ヶ月無料で試す</Text>
                )}
              </TouchableOpacity>

              {/* 購入ボタン直下の規約・ポリシー同意リンク（審査員が一目で確認可能） */}
              <View style={styles.inlineConsentRow}>
                <Text style={[styles.consentText, { color: subText }]}>登録により </Text>
                <TouchableOpacity
                  onPress={() => openUrl(TERMS_OF_USE_URL)}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                >
                  <Text style={[styles.inlineLinkText, { color: accent }]}>利用規約（EULA）</Text>
                </TouchableOpacity>
                <Text style={[styles.consentText, { color: subText }]}> および </Text>
                <TouchableOpacity
                  onPress={() => openUrl(PRIVACY_POLICY_URL)}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                >
                  <Text style={[styles.inlineLinkText, { color: accent }]}>プライバシーポリシー</Text>
                </TouchableOpacity>
                <Text style={[styles.consentText, { color: subText }]}> に同意したものとみなされます</Text>
              </View>
            </View>
          )}

          {/* 購入の復元ボタン（Apple審査必須） */}
          <TouchableOpacity
            style={styles.restoreButton}
            onPress={handleRestore}
            disabled={loading}
            hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }}
          >
            <Text style={[styles.restoreButtonText, { color: accent }]}>
              以前購入された方はこちら（購入の復元）
            </Text>
          </TouchableOpacity>

          {/* 規約・サブスクリプション説明（Apple審査ガイドライン3.1.2(c)必須要件） */}
          <View style={styles.termsContainer}>
            <Text style={[styles.legalText, { color: subText }]}>
              【定期購読（自動更新）および無料トライアルについて】{'\n'}
              ・プラン名：AssistTimer Pro（月額プラン）{'\n'}
              ・購読期間：1ヶ月間（月額自動更新）{'\n'}
              ・価格：月額100円（税込）{'\n'}
              ・初回登録時は「1ヶ月間の無料トライアル」が適用されます。無料体験期間中に解約した場合、料金は一切請求されません。{'\n'}
              ・無料トライアル終了後は月額100円の自動更新となります。{'\n'}
              ・現在の期間が終了する24時間前までに自動更新をオフにしない限り、登録は自動的に更新されます。{'\n'}
              ・アカウントへの請求は、現在の有効期間終了前24時間以内に行われます。{'\n'}
              ・購読の管理や自動更新の解除は、購入後に端末の「設定」＞「Apple ID」＞「サブスクリプション」からいつでも行えます。
            </Text>

            {/* 明確なボタン形式のリンクボタン */}
            <View style={styles.linksRow}>
              <TouchableOpacity
                style={styles.policyButton}
                onPress={() => openUrl(TERMS_OF_USE_URL)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={[styles.linkText, { color: accent }]}>利用規約（EULA）</Text>
              </TouchableOpacity>
              <Text style={{ color: subText, marginHorizontal: 12 }}>|</Text>
              <TouchableOpacity
                style={styles.policyButton}
                onPress={() => openUrl(PRIVACY_POLICY_URL)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={[styles.linkText, { color: accent }]}>プライバシーポリシー</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    alignItems: 'flex-end',
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#3A3A3C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    alignItems: 'center',
  },
  heroSection: {
    alignItems: 'center',
    marginVertical: 16,
  },
  proBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 10,
  },
  proBadgeText: {
    color: '#000',
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  featuresCard: {
    width: '100%',
    borderRadius: 16,
    padding: 18,
    marginVertical: 16,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  featureIcon: {
    fontSize: 28,
    marginRight: 14,
  },
  featureTextWrapper: {
    flex: 1,
  },
  featureTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 3,
  },
  featureDesc: {
    fontSize: 12,
    lineHeight: 16,
  },
  featureDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#3A3A3C',
    marginVertical: 14,
  },
  planCard: {
    width: '100%',
    borderRadius: 16,
    borderWidth: 2,
    padding: 20,
    marginBottom: 20,
    alignItems: 'center',
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  planName: {
    fontSize: 17,
    fontWeight: '700',
    marginRight: 8,
  },
  activeTag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  activeTagText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  priceCurrency: {
    fontSize: 22,
    fontWeight: '700',
  },
  priceAmount: {
    fontSize: 38,
    fontWeight: '800',
  },
  pricePeriod: {
    fontSize: 15,
    fontWeight: '500',
  },
  planNote: {
    fontSize: 12,
  },
  purchaseButton: {
    width: '100%',
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  purchaseButtonText: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
  },
  subscribedBanner: {
    width: '100%',
    height: 50,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  restoreButton: {
    paddingVertical: 10,
    marginBottom: 24,
  },
  restoreButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  termsContainer: {
    width: '100%',
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#3A3A3C',
    alignItems: 'center',
  },
  legalText: {
    fontSize: 10,
    lineHeight: 14,
    textAlign: 'left',
    marginBottom: 12,
  },
  linksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
    paddingVertical: 4,
  },
  policyButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  linkText: {
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  inlineConsentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
  },
  consentText: {
    fontSize: 11,
    lineHeight: 16,
  },
  inlineLinkText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
