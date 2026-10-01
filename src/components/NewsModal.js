import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  SafeAreaView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { 
  NEWS_CATEGORIES, 
  NEWS_ITEMS, 
  partitionNewsItems 
} from '../data/newsData';

/**
 * お知らせ & アップデートモーダル
 */
export default function NewsModal({
  visible,
  onClose,
  readNewsIds = [],
  onMarkAsRead,
  onMarkAllAsRead,
  onHideUntilNextUpdate,
  onRestoreNewsIcon,
  isNewsHiddenUntilNext = false,
  isEcoMode = false,
}) {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);

  // アクティブと期限切れ（アーカイブ）に分類
  const { activeItems, expiredItems } = partitionNewsItems(NEWS_ITEMS);

  // カテゴリフィルター適用
  const filterItems = (items) => {
    if (selectedCategory === 'all') return items;
    return items.filter(item => item.category === selectedCategory);
  };

  const filteredActiveItems = filterItems(activeItems);
  const filteredExpiredItems = filterItems(expiredItems);

  const readSet = new Set(readNewsIds);

  // 「次の更新まで隠す」確認ダイアログ
  const handleConfirmHideUntilNext = () => {
    Alert.alert(
      '次の更新までアイコンを隠す',
      'すべてのお知らせを既読にし、新しい更新が追加されるまで画面左上のNEWSアイコンを非表示にします。\n\n※設定画面からいつでも再表示・過去ログ確認ができます。',
      [
        { text: 'キャンセル', style: 'cancel' },
        { 
          text: '隠す（画面をすっきり）', 
          style: 'default',
          onPress: () => {
            if (onHideUntilNextUpdate) {
              onHideUntilNextUpdate();
            }
          }
        },
      ]
    );
  };

  // テーマカラー
  const bgColor = isEcoMode ? '#1C1C1E' : '#FFFFFF';
  const cardBgColor = isEcoMode ? '#2C2C2E' : '#FFFFFF';
  const cardBorderColor = isEcoMode ? '#3A3A3C' : '#E5E5EA';
  const textColor = isEcoMode ? '#FFFFFF' : '#1C1C1E';
  const textMutedColor = isEcoMode ? '#8E8E93' : '#687076';
  const readCardBg = isEcoMode ? '#18181A' : '#F8F9FA';
  const readCardBorder = isEcoMode ? '#262628' : '#EEEEF0';

  // お知らせカード描画
  const renderNewsCard = (item, isExpired = false) => {
    const isRead = readSet.has(item.id);
    const catConfig = NEWS_CATEGORIES[item.category] || NEWS_CATEGORIES.other;

    return (
      <View
        key={item.id}
        style={[
          styles.card,
          {
            backgroundColor: isRead ? readCardBg : cardBgColor,
            borderColor: isRead ? readCardBorder : cardBorderColor,
            opacity: isRead ? 0.65 : 1.0, // 既読時はグレーアウト
          }
        ]}
      >
        {/* カード上部：日付 ＋ カテゴリバッジ ＋ 既読状態 */}
        <View style={styles.cardHeader}>
          <View style={styles.headerLeftRow}>
            <View style={[styles.categoryBadge, { backgroundColor: catConfig.color + '1A' }]}>
              <Ionicons name={catConfig.icon} size={12} color={catConfig.color} style={{ marginRight: 3 }} />
              <Text style={[styles.categoryBadgeText, { color: catConfig.color }]}>
                {catConfig.label}
              </Text>
            </View>
            <Text style={[styles.dateText, { color: textMutedColor }]}>
              {item.date}
            </Text>
          </View>

          {isRead ? (
            <View style={styles.readStatusBadge}>
              <Ionicons name="checkmark-done" size={13} color="#8E8E93" />
              <Text style={styles.readStatusText}>既読</Text>
            </View>
          ) : (
            <View style={styles.unreadStatusBadge}>
              <Text style={styles.unreadStatusText}>NEW</Text>
            </View>
          )}
        </View>

        {/* タイトル */}
        <Text style={[styles.cardTitle, { color: isRead ? textMutedColor : textColor }]}>
          {item.title}
        </Text>

        {/* 本文説明 */}
        <Text style={[styles.cardBody, { color: textMutedColor }]}>
          {item.body}
        </Text>

        {/* 下部アクション：未読の場合は「既読にする」ボタン */}
        {!isRead && (
          <View style={styles.cardFooter}>
            <TouchableOpacity
              style={styles.markReadButton}
              onPress={() => onMarkAsRead(item.id)}
              activeOpacity={0.7}
            >
              <Ionicons name="checkmark-circle-outline" size={16} color="#007AFF" />
              <Text style={styles.markReadButtonText}>既読にする</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: bgColor }]}>
          {/* ヘッダー */}
          <View style={[styles.header, { borderBottomColor: cardBorderColor }]}>
            <View style={styles.headerTitleRow}>
              <Ionicons name="megaphone" size={20} color="#FF9500" style={{ marginRight: 6 }} />
              <Text style={[styles.headerTitle, { color: textColor }]}>
                お知らせ & アップデート
              </Text>
            </View>
            <TouchableOpacity 
              onPress={onClose} 
              style={styles.closeButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close" size={24} color={textColor} />
            </TouchableOpacity>
          </View>

          {/* クイックアクションバー */}
          <View style={[styles.actionToolbar, { borderBottomColor: cardBorderColor }]}>
            <TouchableOpacity
              style={[styles.toolButton, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7' }]}
              onPress={onMarkAllAsRead}
              activeOpacity={0.7}
            >
              <Ionicons name="checkmark-done-outline" size={15} color="#007AFF" />
              <Text style={styles.toolButtonText}>すべて既読</Text>
            </TouchableOpacity>

            {isNewsHiddenUntilNext ? (
              <TouchableOpacity
                style={[styles.toolButton, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7' }]}
                onPress={() => {
                  if (onRestoreNewsIcon) {
                    onRestoreNewsIcon();
                  }
                  Alert.alert('アイコンを再表示', 'タイマー画面にNEWSアイコンを再表示しました。');
                }}
                activeOpacity={0.7}
              >
                <Ionicons name="eye-outline" size={15} color="#007AFF" />
                <Text style={styles.toolButtonText}>アイコンを再表示</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.toolButton, { backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7' }]}
                onPress={handleConfirmHideUntilNext}
                activeOpacity={0.7}
              >
                <Ionicons name="eye-off-outline" size={15} color="#FF9500" />
                <Text style={styles.toolButtonText}>次の更新まで隠す</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* カテゴリフィルターチップ（水平スクロール） */}
          <View style={styles.chipBarContainer}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipScroll}
            >
              {Object.keys(NEWS_CATEGORIES).map(key => {
                const cat = NEWS_CATEGORIES[key];
                const isSelected = selectedCategory === cat.id;
                return (
                  <TouchableOpacity
                    key={cat.id}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: isSelected
                          ? cat.color
                          : (isEcoMode ? '#2C2C2E' : '#F2F2F7'),
                        borderColor: isSelected ? cat.color : cardBorderColor,
                      }
                    ]}
                    onPress={() => setSelectedCategory(cat.id)}
                    activeOpacity={0.7}
                  >
                    <Ionicons 
                      name={cat.icon} 
                      size={13} 
                      color={isSelected ? '#FFFFFF' : textMutedColor} 
                      style={{ marginRight: 4 }}
                    />
                    <Text
                      style={[
                        styles.chipText,
                        {
                          color: isSelected ? '#FFFFFF' : textMutedColor,
                          fontWeight: isSelected ? '700' : '500',
                        }
                      ]}
                    >
                      {cat.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* お知らせコンテンツスクロール */}
          <ScrollView 
            style={styles.contentScroll} 
            contentContainerStyle={styles.contentContainer}
            showsVerticalScrollIndicator={true}
          >
            {/* アクティブお知らせ一覧 */}
            {filteredActiveItems.length > 0 ? (
              filteredActiveItems.map(item => renderNewsCard(item, false))
            ) : (
              <View style={styles.emptyContainer}>
                <Ionicons name="notifications-off-outline" size={36} color={textMutedColor} />
                <Text style={[styles.emptyText, { color: textMutedColor }]}>
                  該当するお知らせはありません
                </Text>
              </View>
            )}

            {/* 過去のお知らせアコーディオン */}
            {filteredExpiredItems.length > 0 && (
              <View style={styles.archiveSection}>
                <TouchableOpacity
                  style={[
                    styles.archiveAccordionHeader,
                    {
                      backgroundColor: isEcoMode ? '#2C2C2E' : '#F2F2F7',
                      borderColor: cardBorderColor,
                    }
                  ]}
                  onPress={() => setIsArchiveOpen(!isArchiveOpen)}
                  activeOpacity={0.7}
                >
                  <View style={styles.archiveTitleRow}>
                    <Ionicons name="folder-open-outline" size={17} color={textMutedColor} style={{ marginRight: 6 }} />
                    <Text style={[styles.archiveTitle, { color: textColor }]}>
                      過去のお知らせ（{filteredExpiredItems.length}件）
                    </Text>
                  </View>
                  <Ionicons 
                    name={isArchiveOpen ? 'chevron-up' : 'chevron-down'} 
                    size={18} 
                    color={textMutedColor} 
                  />
                </TouchableOpacity>

                {isArchiveOpen && (
                  <View style={styles.archiveContent}>
                    {filteredExpiredItems.map(item => renderNewsCard(item, true))}
                  </View>
                )}
              </View>
            )}

            <View style={{ height: 30 }} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'flex-end',
  },
  modalContainer: {
    height: '88%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
      },
      android: {
        elevation: 10,
      },
    }),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  closeButton: {
    padding: 4,
  },
  actionToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  toolButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  toolButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#007AFF',
    marginLeft: 4,
  },
  chipBarContainer: {
    paddingVertical: 8,
  },
  chipScroll: {
    paddingHorizontal: 16,
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontSize: 13,
  },
  contentScroll: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 3,
      },
      android: {
        elevation: 1,
      },
    }),
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerLeftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  categoryBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  dateText: {
    fontSize: 12,
  },
  readStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  readStatusText: {
    fontSize: 11,
    color: '#8E8E93',
  },
  unreadStatusBadge: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  unreadStatusText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 6,
    lineHeight: 20,
  },
  cardBody: {
    fontSize: 13,
    lineHeight: 19,
  },
  cardFooter: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  markReadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 122, 255, 0.08)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    gap: 4,
  },
  markReadButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#007AFF',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 8,
  },
  emptyText: {
    fontSize: 14,
  },
  archiveSection: {
    marginTop: 8,
  },
  archiveAccordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  archiveTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  archiveTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  archiveContent: {
    marginTop: 10,
  },
});
