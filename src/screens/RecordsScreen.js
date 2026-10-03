import React, { useState, useEffect, useContext, useMemo, useRef } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  FlatList, 
  TouchableOpacity, 
  Image, 
  Modal, 
  Button, 
  ScrollView, 
  Dimensions,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
const { width: screenWidth } = Dimensions.get('window');
import { useIsFocused } from '@react-navigation/native';
import ImageViewer from 'react-native-image-zoom-viewer';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getRecords, updateRecordPhoto, toggleRecordFavorite, formatRecordDateTime, formatCompactDateTime } from '../utils/recordStorage';
import { getFullPracticeStats } from '../utils/practiceStats';
import { AppContext } from '../utils/AppContext';
import AdBannerComponent from '../components/AdBannerComponent';
import ProSubscriptionModal from '../components/ProSubscriptionModal';
import PracticeStatsCard from '../components/PracticeStatsCard';

// AndroidでLayoutAnimationを有効化
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ギャラリーアイテム幅（左右マージン12*2=24, 間隔8をMath.floorで確実に整数化）
const galleryItemWidth = Math.floor((screenWidth - 24 - 8) / 2);

export default function RecordsScreen() {
  const [records, setRecords] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [fullScreenIndex, setFullScreenIndex] = useState(null);
  const [proModalVisible, setProModalVisible] = useState(false);

  // 表示モード切替: 'list' (通常リスト) | 'gallery' (写真ギャラリー)
  const [viewMode, setViewMode] = useState('list');
  // サムネイル上の成長データ（タイム・日時・回数）表示トグル
  const [showGalleryOverlay, setShowGalleryOverlay] = useState(true);

  // ジャンル絞り込み・お気に入り・ソート用State
  const [selectedGenre, setSelectedGenre] = useState('すべて');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [sortBy, setSortBy] = useState('newest'); // 'newest' | 'favoriteFirst' | 'oldest'
  const [genreOrder, setGenreOrder] = useState([]); // 最近押したジャンル順（MRU）
  // ジャンル絞り込みアコーディオン開閉State（初期値: false でコンパクトに表示）
  const [isGenreAccordionOpen, setIsGenreAccordionOpen] = useState(false);
  const genreScrollRef = useRef(null);

  const { isEcoMode, isProMode } = useContext(AppContext);
  const isFocused = useIsFocused();

  // 最近押したジャンル順序および表示モード設定の初期ロード
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [storedGenreOrder, storedViewMode, storedOverlay, storedGenreAccordionOpen] = await Promise.all([
          AsyncStorage.getItem('@records_genre_order'),
          AsyncStorage.getItem('@records_view_mode'),
          AsyncStorage.getItem('@records_gallery_overlay_enabled'),
          AsyncStorage.getItem('@records_genre_accordion_open'),
        ]);

        if (storedGenreOrder) {
          const parsed = JSON.parse(storedGenreOrder);
          if (Array.isArray(parsed)) {
            setGenreOrder(parsed);
          }
        }
        if (storedViewMode) {
          setViewMode(storedViewMode);
        }
        if (storedOverlay !== null) {
          setShowGalleryOverlay(JSON.parse(storedOverlay));
        }
        if (storedGenreAccordionOpen !== null) {
          setIsGenreAccordionOpen(JSON.parse(storedGenreAccordionOpen));
        }
      } catch (e) {
        console.error('Failed to load records settings', e);
      }
    };
    loadSettings();
  }, []);

  // 画面が表示されるたびにデータを読み込む
  useEffect(() => {
    if (isFocused) {
      loadData();
    }
  }, [isFocused]);

  const loadData = async () => {
    const [data, fullStats] = await Promise.all([
      getRecords(),
      getFullPracticeStats(),
    ]);
    setRecords(data);
    setStats(fullStats);
  };

  // お気に入り判定ヘルパー
  const isItemFavorite = (item) => {
    if (!item) return false;
    return item.isFavorite === true || (Array.isArray(item.tags) && item.tags.includes('お気に入り'));
  };

  // お気に入りトグル
  const handleToggleFavorite = async (recordId) => {
    const updated = await toggleRecordFavorite(recordId);
    setRecords(updated);
    if (selectedRecord && selectedRecord.id === recordId) {
      const refreshed = updated.find(r => r.id === recordId);
      if (refreshed) {
        setSelectedRecord(refreshed);
      }
    }
  };

  // 画像変更機能
  const handleChangePhoto = async (recordId) => {
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permissionResult.granted === false) {
      alert("写真へのアクセス許可が必要です。");
      return;
    }

    const pickerResult = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      quality: 0.8,
    });

    if (!pickerResult.canceled) {
      const newUris = pickerResult.assets.map(a => a.uri).slice(0, 4);
      const updated = await updateRecordPhoto(recordId, newUris[0]);
      setRecords(updated);
      
      // 開いているモーダルの更新
      if (selectedRecord && selectedRecord.id === recordId) {
        setSelectedRecord({ ...selectedRecord, photoUris: newUris, photoUri: newUris[0] });
      }
    }
  };

  // ジャンル選択ハンドラー（「すべて」は固定先頭。2番目以降に最近押したジャンルを即座に移動）
  const handleSelectGenre = (genre) => {
    setSelectedGenre(genre);
    if (genre !== 'すべて') {
      setGenreOrder(prevOrder => {
        const nextOrder = [genre, ...prevOrder.filter(g => g !== genre)];
        AsyncStorage.setItem('@records_genre_order', JSON.stringify(nextOrder)).catch(console.error);
        return nextOrder;
      });
      // レイアウト再計算後に一番左（「すべて」と2番目に並んだ選択ジャンル）が見えるよう左端へスムーズスクロール
      setTimeout(() => {
        if (genreScrollRef.current) {
          genreScrollRef.current.scrollTo({ x: 0, animated: true });
        }
      }, 60);
    }
  };

  // フィルター全解除（スクロールも一番左の「すべて」にスムーズ復帰）
  const handleResetFilter = () => {
    setSelectedGenre('すべて');
    setShowFavoritesOnly(false);
    setTimeout(() => {
      if (genreScrollRef.current) {
        genreScrollRef.current.scrollTo({ x: 0, animated: true });
      }
    }, 60);
  };

  // ジャンル絞り込みアコーディオン開閉トグル
  const toggleGenreAccordion = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const nextState = !isGenreAccordionOpen;
    setIsGenreAccordionOpen(nextState);
    AsyncStorage.setItem('@records_genre_accordion_open', JSON.stringify(nextState)).catch(console.error);
  };

  // ジャンル候補（記録に存在するジャンル＋主要デフォルトジャンル）
  const defaultGenres = ['カット', 'カラー', 'ワインディング', 'アップスタイル'];
  const recordGenres = useMemo(() => Array.from(new Set(records.map(r => r.category).filter(Boolean))), [records]);
  const allAvailableGenres = useMemo(() => Array.from(new Set([...recordGenres, ...defaultGenres])), [recordGenres]);

  // 「すべて」は常に一番左で固定。2番目以降は最近押したものが近い順（genreOrder）で並ぶ
  const allGenresList = useMemo(() => {
    const ordered = genreOrder.filter(g => allAvailableGenres.includes(g));
    const remaining = allAvailableGenres.filter(g => !ordered.includes(g));
    return ['すべて', ...ordered, ...remaining];
  }, [genreOrder, allAvailableGenres]);

  // ジャンル別件数マップ
  const genreCountMap = useMemo(() => {
    return records.reduce((acc, r) => {
      const cat = r.category || '未設定';
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {});
  }, [records]);

  // 絞り込み＆ソート適用後の記録リスト
  const filteredAndSortedRecords = useMemo(() => {
    let result = [...records];

    // ① ジャンル絞り込み
    if (selectedGenre !== 'すべて') {
      result = result.filter(r => r.category === selectedGenre);
    }

    // ② お気に入り絞り込み
    if (showFavoritesOnly) {
      result = result.filter(r => isItemFavorite(r));
    }

    // ③ ソート（並び順）
    result.sort((a, b) => {
      if (sortBy === 'favoriteFirst') {
        const favA = isItemFavorite(a) ? 1 : 0;
        const favB = isItemFavorite(b) ? 1 : 0;
        if (favA !== favB) {
          return favB - favA; // ★お気に入りが上
        }
        return new Date(b.date || 0) - new Date(a.date || 0); // 同列なら新しい順
      } else if (sortBy === 'oldest') {
        return new Date(a.date || 0) - new Date(b.date || 0); // 古い順
      } else {
        return new Date(b.date || 0) - new Date(a.date || 0); // 新しい順（デフォルト）
      }
    });

    return result;
  }, [records, selectedGenre, showFavoritesOnly, sortBy]);

  // 写真URI取得ヘルパー
  const getItemPhotoUri = (item) => {
    if (!item) return null;
    if (item.photoUris && item.photoUris.length > 0 && item.photoUris[0]) {
      return item.photoUris[0];
    }
    return item.photoUri || null;
  };

  // 各記録の「その時点の練習回数」（ジャンル別 ＆ 全体通算）を時系列順に算出
  const practiceCountsMap = useMemo(() => {
    const sortedChronological = [...records].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    
    const genreCountTracker = {};
    const countMap = {};

    sortedChronological.forEach((rec, idx) => {
      const cat = rec.category || '未設定';
      genreCountTracker[cat] = (genreCountTracker[cat] || 0) + 1;
      countMap[rec.id] = {
        overallIndex: idx + 1,
        genreIndex: genreCountTracker[cat],
        category: cat,
      };
    });

    return countMap;
  }, [records]);

  // 写真付き記録の総数
  const totalPhotosCount = useMemo(() => {
    return records.filter(r => Boolean(getItemPhotoUri(r))).length;
  }, [records]);

  // 表示モードに応じた表示データ（写真ギャラリー時は写真ありのみ抽出）
  const displayRecords = useMemo(() => {
    if (viewMode === 'gallery') {
      return filteredAndSortedRecords.filter(item => Boolean(getItemPhotoUri(item)));
    }
    return filteredAndSortedRecords;
  }, [filteredAndSortedRecords, viewMode]);

  // 表示モード切り替えハンドラー
  const handleToggleViewMode = (mode) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setViewMode(mode);
    AsyncStorage.setItem('@records_view_mode', mode).catch(console.error);
  };

  // ギャラリー上の成長データ（タイム・日時・回数）表示トグル
  const handleToggleGalleryOverlay = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const nextState = !showGalleryOverlay;
    setShowGalleryOverlay(nextState);
    AsyncStorage.setItem('@records_gallery_overlay_enabled', JSON.stringify(nextState)).catch(console.error);
  };

  // カラー定義
  const bgColor = isEcoMode ? '#000' : '#F2F2F7';
  const tileBgColor = isEcoMode ? '#111' : '#fff';
  const textColor = isEcoMode ? '#fff' : '#333';
  const subTextColor = isEcoMode ? '#888' : '#8E8E93';
  const cardBorder = isEcoMode ? '#222' : '#E5E5EA';

  const formatDuration = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}分${s}秒`;
  };

  // ギャラリータイル（インスタ風正方形グリッド）の描画（タッチ判定分離アーキテクチャ）
  const renderGalleryItem = ({ item }) => {
    const photoUri = getItemPhotoUri(item);
    if (!photoUri) return null;

    const isFav = isItemFavorite(item);
    const countInfo = practiceCountsMap[item.id];
    const genreIdx = countInfo?.genreIndex || 1;
    const catName = item.category || '未設定';
    const photosCount = (item.photoUris && item.photoUris.length > 0) ? item.photoUris.length : (item.photoUri ? 1 : 0);

    // 日時フォーマット（M/D HH:mm 形式）
    const dateFormatted = formatCompactDateTime(item.date);

    // タイムフォーマット（m分s秒）
    const durationFormatted = formatDuration(item.duration);

    return (
      <View style={[styles.galleryTileWrapper, { width: galleryItemWidth }]}>
        <View style={[styles.galleryTile, { backgroundColor: isEcoMode ? '#18181A' : '#E5E5EA', borderColor: cardBorder }]}>
          {/* メイン詳細タップ領域（写真 ＆ オーバーレイ情報） */}
          <TouchableOpacity
            style={styles.galleryMainPressable}
            onPress={() => {
              setSelectedRecord(item);
              setModalVisible(true);
            }}
            activeOpacity={0.85}
          >
            <Image
              source={{ uri: photoUri }}
              style={styles.galleryImage}
              resizeMode="cover"
            />

            {/* 任意表示のオーバーレイ情報 */}
            {showGalleryOverlay && (
              <>
                {/* 左上: ジャンル＆回数 */}
                <View style={styles.galleryTopLeft}>
                  <View style={[styles.galleryCountBadge, { backgroundColor: 'rgba(0,0,0,0.65)' }]}>
                    <Text style={styles.galleryCountBadgeText} numberOfLines={1} ellipsizeMode="tail">
                      {catName} #{genreIdx}
                    </Text>
                  </View>
                </View>

                {/* 下部: タイム ＆ 日時 */}
                <View style={styles.galleryBottomOverlay}>
                  <View style={styles.galleryTimeRow}>
                    <Ionicons name="stopwatch" size={11} color="#64D2FF" style={{ marginRight: 3 }} />
                    <Text style={styles.galleryTimeText}>{durationFormatted}</Text>
                  </View>
                  <Text style={styles.galleryDateText}>{dateFormatted}</Text>
                </View>
              </>
            )}
          </TouchableOpacity>

          {/* 右上独立エリア: ★お気に入りボタン ＆ 複数枚写真インジケーター（並列配置により誤爆を100%根本防止） */}
          <View style={styles.galleryTopRight} pointerEvents="box-none">
            {photosCount > 1 && (
              <View style={[styles.galleryMultiPhotoBadge, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
                <Ionicons name="copy-outline" size={10} color="#FFFFFF" style={{ marginRight: 2 }} />
                <Text style={styles.galleryMultiPhotoText}>{photosCount}</Text>
              </View>
            )}

            {(showGalleryOverlay || isFav) && (
              <TouchableOpacity
                style={styles.galleryFavButton}
                onPress={() => handleToggleFavorite(item.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.6}
              >
                <Ionicons
                  name={isFav ? "star" : "star-outline"}
                  size={18}
                  color={isFav ? "#FFB800" : "rgba(255,255,255,0.85)"}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    );
  };

  // タイル（個別の記録行）の描画（詳細タップ領域と★ボタンを完全に分離して誤爆防止）
  const renderItem = ({ item }) => {
    const dateStr = formatRecordDateTime(item.date);
    const isFav = isItemFavorite(item);

    return (
      <View style={[styles.recordTile, { backgroundColor: tileBgColor, shadowColor: isEcoMode ? 'transparent' : '#000' }]}>
        {/* メイン詳細タップ領域（画像・テキスト） */}
        <TouchableOpacity 
          style={styles.tileMainPressable} 
          onPress={() => {
            setSelectedRecord(item);
            setModalVisible(true);
          }}
          activeOpacity={0.7}
        >
          {((item.photoUris && item.photoUris.length > 0) ? item.photoUris[0] : item.photoUri) ? (
            <Image 
              source={{ uri: (item.photoUris && item.photoUris.length > 0) ? item.photoUris[0] : item.photoUri }} 
              style={styles.tileImage} 
              resizeMode="cover"
            />
          ) : (
            <View style={[styles.tileImage, styles.placeholderImage, isEcoMode && { backgroundColor: '#222' }]}>
               <Text style={styles.placeholderText}>NO PHOTO</Text>
            </View>
          )}

          <View style={styles.tileInfo}>
            <Text style={[styles.tileDate, { color: subTextColor }]}>{dateStr}</Text>
            <Text style={[styles.tileCategory, { color: textColor }]}>{item.category || 'カテゴリ未設定'}</Text>
            <Text style={[styles.tileDuration, { color: textColor }]}>タイム: {formatDuration(item.duration)}</Text>
            
            {item.tags && item.tags.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 5 }}>
                {item.tags.map((tag, i) => {
                  const isFavTag = tag === 'お気に入り';
                  return (
                    <View 
                      key={i} 
                      style={[
                        styles.tagBadge, 
                        isFavTag && styles.favoriteTagBadge,
                        isEcoMode && { backgroundColor: isFavTag ? '#352A10' : '#2A2A2E' }
                      ]}
                    >
                      <Text style={[
                        styles.tagBadgeText, 
                        isFavTag && styles.favoriteTagBadgeText,
                        isEcoMode && { color: isFavTag ? '#FFD60A' : '#aaa' }
                      ]}>
                        {isFavTag ? '★ お気に入り' : `#${tag}`}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </TouchableOpacity>

        {/* 独立したお気に入りボタン（親のモーダルが絶対に誤爆しない） */}
        <TouchableOpacity 
          style={styles.tileFavButton}
          onPress={() => handleToggleFavorite(item.id)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.6}
        >
          <Ionicons 
            name={isFav ? "star" : "star-outline"} 
            size={24} 
            color={isFav ? "#FFB800" : (isEcoMode ? "#555" : "#C7C7CC")} 
          />
        </TouchableOpacity>
      </View>
    );
  };

  // リストヘッダー（統計サマリー ＋ 表示モード切替 ＋ ジャンルタグチップバー ＋ フィルター/ソート操作）
  const renderListHeader = () => (
    <View style={{ marginBottom: 6 }}>
      {stats ? <PracticeStatsCard stats={stats} /> : null}

      {/* 表示モード切替セグメントタブ (リスト ⇔ 写真アルバム) */}
      <View style={[styles.viewModeContainer, { backgroundColor: isEcoMode ? '#1C1C1E' : '#E2E8F0', borderColor: cardBorder }]}>
        <TouchableOpacity
          style={[
            styles.viewModeBtn,
            viewMode === 'list' && (isEcoMode ? styles.viewModeBtnActiveEco : styles.viewModeBtnActiveNormal)
          ]}
          onPress={() => handleToggleViewMode('list')}
          activeOpacity={0.7}
        >
          <Ionicons
            name="list"
            size={17}
            color={viewMode === 'list' ? '#FFFFFF' : (isEcoMode ? '#888' : '#64748B')}
            style={{ marginRight: 6 }}
          />
          <Text style={[
            styles.viewModeBtnText,
            viewMode === 'list' 
              ? (isEcoMode ? styles.viewModeBtnTextActiveEco : styles.viewModeBtnTextActiveNormal)
              : { color: isEcoMode ? '#888' : '#475569' }
          ]}>
            リスト一覧
          </Text>
          <View style={[
            styles.viewModeCountBadge,
            viewMode === 'list' 
              ? (isEcoMode ? styles.viewModeCountBadgeActiveEco : styles.viewModeCountBadgeActiveNormal)
              : { backgroundColor: isEcoMode ? '#2C2C2E' : 'rgba(0,0,0,0.06)' }
          ]}>
            <Text style={[
              styles.viewModeCountBadgeText,
              viewMode === 'list' 
                ? (isEcoMode ? styles.viewModeCountBadgeTextActiveEco : styles.viewModeCountBadgeTextActiveNormal)
                : { color: isEcoMode ? '#888' : '#64748B' }
            ]}>
              {records.length}
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.viewModeBtn,
            viewMode === 'gallery' && (isEcoMode ? styles.viewModeBtnActiveEco : styles.viewModeBtnActiveNormal)
          ]}
          onPress={() => handleToggleViewMode('gallery')}
          activeOpacity={0.7}
        >
          <Ionicons
            name="images"
            size={17}
            color={viewMode === 'gallery' ? '#FFFFFF' : (isEcoMode ? '#888' : '#64748B')}
            style={{ marginRight: 6 }}
          />
          <Text style={[
            styles.viewModeBtnText,
            viewMode === 'gallery' 
              ? (isEcoMode ? styles.viewModeBtnTextActiveEco : styles.viewModeBtnTextActiveNormal)
              : { color: isEcoMode ? '#888' : '#475569' }
          ]}>
            写真アルバム
          </Text>
          <View style={[
            styles.viewModeCountBadge,
            viewMode === 'gallery' 
              ? (isEcoMode ? styles.viewModeCountBadgeActiveEco : styles.viewModeCountBadgeActiveNormal)
              : { backgroundColor: isEcoMode ? '#2C2C2E' : 'rgba(0,0,0,0.06)' }
          ]}>
            <Text style={[
              styles.viewModeCountBadgeText,
              viewMode === 'gallery' 
                ? (isEcoMode ? styles.viewModeCountBadgeTextActiveEco : styles.viewModeCountBadgeTextActiveNormal)
                : { color: isEcoMode ? '#888' : '#64748B' }
            ]}>
              {totalPhotosCount}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* ジャンルタグ ＆ お気に入りフィルター コントロールボックス（開閉式アコーディオン） */}
      {(() => {
        const isFilterActive = selectedGenre !== 'すべて' || showFavoritesOnly;
        return (
          <View style={[styles.filterCard, { backgroundColor: tileBgColor, borderColor: cardBorder }]}>
            
            {/* アコーディオンヘッダー（タップで開閉） */}
            <TouchableOpacity 
              style={styles.filterAccordionHeader}
              onPress={toggleGenreAccordion}
              activeOpacity={0.7}
            >
              <View style={styles.filterSectionHeaderLeft}>
                <Ionicons 
                  name="pricetags" 
                  size={16} 
                  color={isEcoMode ? '#64D2FF' : '#007AFF'} 
                  style={{ marginRight: 6 }} 
                />
                <Text style={[styles.filterSectionTitle, { color: textColor }]}>ジャンルで絞り込み</Text>
              </View>

              <View style={styles.filterSectionHeaderRight}>
                {/* 絞り込み状態サマリーバッジ */}
                <View style={[
                  styles.filterSummaryBadge,
                  isFilterActive 
                    ? (showFavoritesOnly
                        ? (isEcoMode ? styles.filterSummaryBadgeFavEco : styles.filterSummaryBadgeFav)
                        : (isEcoMode ? styles.filterSummaryBadgeActiveEco : styles.filterSummaryBadgeActive))
                    : (isEcoMode ? styles.filterSummaryBadgeEco : styles.filterSummaryBadgeNormal)
                ]}>
                  {showFavoritesOnly && (
                    <Ionicons 
                      name="star" 
                      size={11} 
                      color={isEcoMode ? '#FFD60A' : '#B27B00'} 
                      style={{ marginRight: 3 }} 
                    />
                  )}
                  <Text 
                    style={[
                      styles.filterSummaryBadgeText,
                      isFilterActive 
                        ? (showFavoritesOnly
                            ? (isEcoMode ? styles.filterSummaryBadgeTextFavEco : styles.filterSummaryBadgeTextFav)
                            : (isEcoMode ? styles.filterSummaryBadgeTextActiveEco : styles.filterSummaryBadgeTextActive))
                        : { color: isEcoMode ? '#888' : '#666' }
                    ]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {selectedGenre !== 'すべて' ? selectedGenre : '全ジャンル'} {displayRecords.length}件
                  </Text>
                </View>

                <Ionicons
                  name={isGenreAccordionOpen ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={isEcoMode ? '#888' : '#8E8E93'}
                  style={{ marginLeft: 6 }}
                />
              </View>
            </TouchableOpacity>

            {/* アコーディオン展開コンテンツ */}
            {isGenreAccordionOpen && (
              <View style={styles.filterAccordionBody}>
                {/* ① ジャンルタグ選択バー */}
                <ScrollView 
                  ref={genreScrollRef}
                  horizontal 
                  showsHorizontalScrollIndicator={false} 
                  contentContainerStyle={styles.genreChipsScroll}
                >
                  {allGenresList.map((genre) => {
                    const isSelected = selectedGenre === genre;
                    // ギャラリーモード時は写真付き件数、通常時は全件数を表示
                    const count = viewMode === 'gallery'
                      ? (genre === 'すべて' 
                          ? totalPhotosCount 
                          : records.filter(r => r.category === genre && Boolean(getItemPhotoUri(r))).length)
                      : (genre === 'すべて' 
                          ? records.length 
                          : (genreCountMap[genre] || 0));

                    return (
                      <TouchableOpacity
                        key={genre}
                        style={[
                          styles.genreChip,
                          isSelected && (isEcoMode ? styles.genreChipSelectedEco : styles.genreChipSelected),
                          isEcoMode && !isSelected && styles.genreChipEco
                        ]}
                        onPress={() => handleSelectGenre(genre)}
                        activeOpacity={0.7}
                      >
                        <Text style={[
                          styles.genreChipText,
                          isSelected && (isEcoMode ? styles.genreChipTextSelectedEco : styles.genreChipTextSelected),
                          isEcoMode && !isSelected && { color: '#888' }
                        ]}>
                          {genre}
                        </Text>
                        <View style={[
                          styles.genreCountBadge,
                          isSelected && (isEcoMode ? styles.genreCountBadgeSelectedEco : styles.genreCountBadgeSelected)
                        ]}>
                          <Text style={[
                            styles.genreCountBadgeText,
                            isSelected && (isEcoMode ? styles.genreCountBadgeTextSelectedEco : styles.genreCountBadgeTextSelected),
                            isEcoMode && !isSelected && { color: '#888' }
                          ]}>
                            {count}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                {/* ② お気に入りトグル ＆ 並び順（ソート） */}
                <View style={styles.subControlsRow}>
                  {/* 「★ お気に入りのみ」トグルボタン */}
                  <TouchableOpacity
                    style={[
                      styles.favFilterBtn,
                      showFavoritesOnly && styles.favFilterBtnActive,
                      isEcoMode && (showFavoritesOnly ? styles.favFilterBtnActiveEco : styles.favFilterBtnEco)
                    ]}
                    onPress={() => setShowFavoritesOnly(!showFavoritesOnly)}
                    activeOpacity={0.7}
                  >
                    <Ionicons 
                      name={showFavoritesOnly ? "star" : "star-outline"} 
                      size={16} 
                      color={showFavoritesOnly ? "#FFB800" : (isEcoMode ? "#888" : "#8E8E93")} 
                      style={{ marginRight: 5 }} 
                    />
                    <Text style={[
                      styles.favFilterBtnText,
                      showFavoritesOnly && styles.favFilterBtnTextActive,
                      isEcoMode && !showFavoritesOnly && { color: '#aaa' }
                    ]}>
                      ★ お気に入りのみ
                    </Text>
                  </TouchableOpacity>

                  {/* 並び順（ソート）ボタン群 */}
                  <View style={[styles.sortGroup, isEcoMode && { backgroundColor: '#1C1C1E', borderColor: '#2C2C2E' }]}>
                    <TouchableOpacity
                      style={[
                        styles.sortBtn,
                        sortBy === 'newest' && (isEcoMode ? styles.sortBtnActiveEco : styles.sortBtnActive),
                      ]}
                      onPress={() => setSortBy('newest')}
                    >
                      <Text style={[
                        styles.sortBtnText,
                        sortBy === 'newest' && styles.sortBtnTextActive,
                        isEcoMode && sortBy !== 'newest' && { color: '#777' }
                      ]}>新しい順</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.sortBtn,
                        sortBy === 'favoriteFirst' && (isEcoMode ? styles.sortBtnActiveEco : styles.sortBtnActive),
                      ]}
                      onPress={() => setSortBy('favoriteFirst')}
                    >
                      <Text style={[
                        styles.sortBtnText,
                        sortBy === 'favoriteFirst' && styles.sortBtnTextActive,
                        isEcoMode && sortBy !== 'favoriteFirst' && { color: '#777' }
                      ]}>★優先</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.sortBtn,
                        sortBy === 'oldest' && (isEcoMode ? styles.sortBtnActiveEco : styles.sortBtnActive),
                      ]}
                      onPress={() => setSortBy('oldest')}
                    >
                      <Text style={[
                        styles.sortBtnText,
                        sortBy === 'oldest' && styles.sortBtnTextActive,
                        isEcoMode && sortBy !== 'oldest' && { color: '#777' }
                      ]}>古い順</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* ③ 現在の絞り込み状態 ＆ 件数 ＆ 成長データ表示切替 */}
                <View style={styles.statusRow}>
                  <Text style={[styles.statusText, { color: subTextColor }]}>
                    表示: {selectedGenre !== 'すべて' ? `【${selectedGenre}】` : '全ジャンル'}
                    {showFavoritesOnly ? '（★お気に入り）' : ''} {displayRecords.length}件
                  </Text>

                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {/* ギャラリー表示時限定: 成長データ（タイム・日時・回数）表示トグル */}
                    {viewMode === 'gallery' && (
                      <TouchableOpacity 
                        style={[
                          styles.overlayToggleBtn, 
                          showGalleryOverlay && (isEcoMode ? styles.overlayToggleBtnActiveEco : styles.overlayToggleBtnActive),
                          isEcoMode && !showGalleryOverlay && styles.overlayToggleBtnEco
                        ]}
                        onPress={handleToggleGalleryOverlay}
                        activeOpacity={0.7}
                      >
                        <Ionicons 
                          name={showGalleryOverlay ? "stats-chart" : "image-outline"} 
                          size={12} 
                          color={showGalleryOverlay ? (isEcoMode ? "#64D2FF" : "#007AFF") : (isEcoMode ? "#888" : "#8E8E93")} 
                          style={{ marginRight: 4 }} 
                        />
                        <Text style={[
                          styles.overlayToggleBtnText,
                          showGalleryOverlay && (isEcoMode ? styles.overlayToggleBtnTextActiveEco : styles.overlayToggleBtnTextActive),
                          isEcoMode && !showGalleryOverlay && { color: '#888' }
                        ]}>
                          {showGalleryOverlay ? '成長データON' : '写真のみ'}
                        </Text>
                      </TouchableOpacity>
                    )}

                    {(selectedGenre !== 'すべて' || showFavoritesOnly) && (
                      <TouchableOpacity 
                        onPress={handleResetFilter}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Text style={[styles.clearBtnText, isEcoMode && { color: '#64D2FF' }]}>条件リセット</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>
            )}

          </View>
        );
      })()}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      {/* 無料枠の件数ステータスバー */}
      {!isProMode && (
        <TouchableOpacity 
          style={[
            styles.tierBar, 
            { 
              backgroundColor: records.length >= 50 ? '#3A1515' : (isEcoMode ? '#1C1C1E' : '#E5E5EA'),
              borderColor: records.length >= 50 ? '#FF3B30' : 'transparent',
            }
          ]}
          onPress={() => setProModalVisible(true)}
          activeOpacity={0.8}
        >
          <Text style={[styles.tierBarText, { color: records.length >= 50 ? '#FF3B30' : textColor }]} allowFontScaling={false}>
            {records.length >= 50 
              ? '⚠️ 記録枠（50件）に達しました。Proプランで無制限に保存' 
              : `📊 練習記録: ${records.length}/50件（無料枠） ★ Proで無制限`}
          </Text>
        </TouchableOpacity>
      )}

      <FlatList
        key={viewMode === 'gallery' ? 'gallery-grid-2' : 'records-list-1'}
        data={displayRecords}
        numColumns={viewMode === 'gallery' ? 2 : 1}
        columnWrapperStyle={viewMode === 'gallery' ? styles.galleryRow : undefined}
        keyExtractor={(item) => (viewMode === 'gallery' ? `gallery-${item.id}` : item.id)}
        renderItem={viewMode === 'gallery' ? renderGalleryItem : renderItem}
        ListHeaderComponent={renderListHeader}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            {records.length === 0 ? (
              <>
                <Text style={[styles.emptyText, { color: subTextColor }]}>
                  まだ記録がありません。タイマーから練習を記録しましょう！
                </Text>
                <Button title="再読み込み" onPress={loadData} />
              </>
            ) : viewMode === 'gallery' ? (
              <>
                <Ionicons 
                  name="images-outline" 
                  size={48} 
                  color={isEcoMode ? '#444' : '#C7C7CC'} 
                  style={{ marginBottom: 12 }} 
                />
                <Text style={[styles.emptyText, { color: subTextColor, textAlign: 'center', lineHeight: 22 }]}>
                  {totalPhotosCount === 0 
                    ? '写真付きの練習記録がまだありません。\nタイマー終了後の保存画面から写真を添付してみましょう！' 
                    : '該当する写真付きの練習記録が見つかりませんでした。'}
                </Text>
                {totalPhotosCount > 0 && (
                  <TouchableOpacity 
                    style={[styles.resetFilterButton, isEcoMode && { backgroundColor: '#333' }]}
                    onPress={handleResetFilter}
                  >
                    <Text style={styles.resetFilterButtonText}>すべての写真を表示</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <>
                <Ionicons 
                  name="search-outline" 
                  size={48} 
                  color={isEcoMode ? '#444' : '#C7C7CC'} 
                  style={{ marginBottom: 12 }} 
                />
                <Text style={[styles.emptyText, { color: subTextColor }]}>
                  該当する練習記録が見つかりませんでした。
                </Text>
                <TouchableOpacity 
                  style={[styles.resetFilterButton, isEcoMode && { backgroundColor: '#333' }]}
                  onPress={handleResetFilter}
                >
                  <Text style={styles.resetFilterButtonText}>すべての記録を表示</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        }
        contentContainerStyle={[styles.listContainer, displayRecords.length === 0 && { flexGrow: 1 }]}
      />

      {/* 広告バナー（AdMob / Proモード時は非表示） */}
      <AdBannerComponent />

      {/* 詳細・写真変更用モーダル */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={false}
      >
        <ScrollView 
          style={[styles.modalContainer, { backgroundColor: bgColor }]}
          contentContainerStyle={{ paddingBottom: 60 }}
          showsVerticalScrollIndicator={true}
        >
          <Text style={[styles.modalTitle, { color: textColor }]}>練習の記録詳細</Text>
          
          {selectedRecord && (
            <>
              {selectedRecord.photoUris && selectedRecord.photoUris.length > 0 ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginBottom: 15 }}>
                  {selectedRecord.photoUris.map((uri, idx) => (
                    <TouchableOpacity key={idx} onPress={() => setFullScreenIndex(idx)}>
                      <Image source={{ uri }} style={[styles.modalDetailImage, { width: 140, height: 140, margin: 5 }]} resizeMode="cover" />
                    </TouchableOpacity>
                  ))}
                </View>
              ) : selectedRecord.photoUri ? (
                <TouchableOpacity onPress={() => setFullScreenIndex(0)}>
                  <Image source={{ uri: selectedRecord.photoUri }} style={styles.modalDetailImage} resizeMode="cover" />
                </TouchableOpacity>
              ) : (
                <View style={[styles.modalDetailImage, styles.placeholderImage, isEcoMode && { backgroundColor: '#222' }]}>
                  <Text style={styles.placeholderText}>No Photo Available</Text>
                </View>
              )}
              
              <View style={[styles.modalInfoBox, { backgroundColor: tileBgColor }]}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <Text style={[styles.infoText, { color: textColor, marginBottom: 0 }]}>
                    練習日時: {formatRecordDateTime(selectedRecord.date)}
                  </Text>
                  {/* 詳細内お気に入りバッジ */}
                  {isItemFavorite(selectedRecord) && (
                    <View style={styles.modalFavBadge}>
                      <Text style={styles.modalFavBadgeText}>★ お気に入り</Text>
                    </View>
                  )}
                </View>

                <Text style={[styles.infoText, { color: textColor }]}>ジャンル: {selectedRecord.category || 'なし'}</Text>
                <Text style={[styles.infoText, { color: textColor }]}>かかった時間: {formatDuration(selectedRecord.duration)}</Text>
                
                {selectedRecord.memo ? (
                  <Text style={[styles.infoText, { color: textColor, marginTop: 8 }]}>メモ: {selectedRecord.memo}</Text>
                ) : null}

                {selectedRecord.tags && selectedRecord.tags.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
                    {selectedRecord.tags.map((tag, i) => (
                      <View key={i} style={[styles.tagBadge, isEcoMode && { backgroundColor: '#333' }]}>
                        <Text style={[styles.tagBadgeText, isEcoMode && { color: '#aaa' }]}>#{tag}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.modalActionButtons}>
                {/* お気に入り登録／解除ボタン */}
                <TouchableOpacity 
                  style={[
                    styles.actionButton, 
                    isItemFavorite(selectedRecord) ? styles.actionButtonFavActive : styles.actionButtonFav,
                    isEcoMode && { backgroundColor: isItemFavorite(selectedRecord) ? '#7B5E00' : '#2A2A2E' }
                  ]} 
                  onPress={() => handleToggleFavorite(selectedRecord.id)}
                >
                  <Ionicons 
                    name={isItemFavorite(selectedRecord) ? "star" : "star-outline"} 
                    size={20} 
                    color={isItemFavorite(selectedRecord) ? "#FFF" : (isEcoMode ? "#64D2FF" : "#007AFF")} 
                    style={{ marginRight: 8 }} 
                  />
                  <Text style={[
                    styles.actionButtonText, 
                    !isItemFavorite(selectedRecord) && { color: isEcoMode ? '#64D2FF' : '#007AFF' }
                  ]}>
                    {isItemFavorite(selectedRecord) ? "お気に入りを解除する" : "★ お気に入りに追加する"}
                  </Text>
                </TouchableOpacity>

                {/* 写真変更ボタン */}
                <TouchableOpacity 
                  style={[styles.actionButton, isEcoMode && { backgroundColor: '#333' }]} 
                  onPress={() => handleChangePhoto(selectedRecord.id)}
                >
                   <Text style={[styles.actionButtonText, isEcoMode && { color: '#fff' }]}>写真を変更する</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          <TouchableOpacity 
             style={[styles.actionButton, styles.closeButton]} 
             onPress={() => setModalVisible(false)}
          >
             <Text style={styles.actionButtonText}>閉じる</Text>
          </TouchableOpacity>
        </ScrollView>
        
        {/* 写真の全画面プレビュー用オーバーレイ */}
        {fullScreenIndex !== null && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'black', zIndex: 1000, elevation: 100 }}>
            <ImageViewer 
              imageUrls={(selectedRecord?.photoUris && selectedRecord.photoUris.length > 0 ? selectedRecord.photoUris : [selectedRecord?.photoUri]).filter(Boolean).map(uri => ({ url: uri }))}
              index={fullScreenIndex}
              onSwipeDown={() => setFullScreenIndex(null)}
              onClick={() => setFullScreenIndex(null)}
              enableSwipeDown={true}
              renderIndicator={() => null}
            />
          </View>
        )}
      </Modal>

      {/* Proプラン（月額100円）購入モーダル */}
      <ProSubscriptionModal visible={proModalVisible} onClose={() => setProModalVisible(false)} />

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  tierBar: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tierBarText: {
    fontSize: 12,
    fontWeight: '600',
  },
  listContainer: {
    paddingTop: 8,
    paddingBottom: 28,
    paddingHorizontal: 12,
  },

  // フィルター・コントロールボックス
  filterCard: {
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginTop: 10,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  filterAccordionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 24,
  },
  filterSectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    marginRight: 8,
  },
  filterSectionHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  filterSummaryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterSummaryBadgeNormal: {
    backgroundColor: '#F2F2F7',
    borderColor: '#E5E5EA',
  },
  filterSummaryBadgeEco: {
    backgroundColor: '#1C1C1E',
    borderColor: '#2C2C2E',
  },
  filterSummaryBadgeActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
  },
  filterSummaryBadgeActiveEco: {
    backgroundColor: '#1E293B',
    borderColor: '#0284C7',
  },
  filterSummaryBadgeFav: {
    backgroundColor: '#FFF8E6',
    borderColor: '#FFE082',
  },
  filterSummaryBadgeFavEco: {
    backgroundColor: '#2E2610',
    borderColor: '#B45309',
  },
  filterSummaryBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    maxWidth: 160,
  },
  filterSummaryBadgeTextActive: {
    color: '#007AFF',
  },
  filterSummaryBadgeTextActiveEco: {
    color: '#64D2FF',
  },
  filterSummaryBadgeTextFav: {
    color: '#B27B00',
  },
  filterSummaryBadgeTextFavEco: {
    color: '#FFD60A',
  },
  filterAccordionBody: {
    marginTop: 10,
  },
  filterSectionTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  genreChipsScroll: {
    paddingVertical: 4,
    paddingRight: 10,
  },
  genreChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F2F2F7',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  genreChipEco: {
    backgroundColor: '#1C1C1E',
    borderColor: '#2C2C2E',
  },
  genreChipSelected: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  genreChipSelectedEco: {
    backgroundColor: '#0055B3',
    borderColor: '#64D2FF',
  },
  genreChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  genreChipTextSelected: {
    color: '#fff',
    fontWeight: '700',
  },
  genreChipTextSelectedEco: {
    color: '#fff',
    fontWeight: '700',
  },
  genreCountBadge: {
    marginLeft: 6,
    backgroundColor: 'rgba(0,0,0,0.06)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
  },
  genreCountBadgeSelected: {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  genreCountBadgeSelectedEco: {
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  genreCountBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#666',
  },
  genreCountBadgeTextSelected: {
    color: '#fff',
  },
  genreCountBadgeTextSelectedEco: {
    color: '#fff',
  },

  // サブフィルター（お気に入りのみ＆並び順）
  subControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
  favFilterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F2F2F7',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  favFilterBtnEco: {
    backgroundColor: '#1C1C1E',
    borderColor: '#2C2C2E',
  },
  favFilterBtnActive: {
    backgroundColor: '#FFF8E6',
    borderColor: '#FFB800',
  },
  favFilterBtnActiveEco: {
    backgroundColor: '#2E2610',
    borderColor: '#FFB800',
  },
  favFilterBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#555',
  },
  favFilterBtnTextActive: {
    color: '#B27B00',
    fontWeight: '700',
  },
  sortGroup: {
    flexDirection: 'row',
    backgroundColor: '#E5E5EA',
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: '#D1D1D6',
  },
  sortBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  sortBtnActive: {
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  sortBtnActiveEco: {
    backgroundColor: '#2C2C2E',
  },
  sortBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#666',
  },
  sortBtnTextActive: {
    color: '#007AFF',
    fontWeight: '700',
  },

  // ステータス表示
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingHorizontal: 2,
  },
  statusText: {
    fontSize: 11,
  },
  clearBtnText: {
    fontSize: 11,
    color: '#007AFF',
    fontWeight: '600',
  },

  // 記録タイル
  recordTile: {
    position: 'relative',
    borderRadius: 12,
    marginBottom: 10,
    shadowOpacity: 0.08,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  tileMainPressable: {
    flexDirection: 'row',
    padding: 10,
    paddingRight: 42, // ★ボタンの領域を確保して文字重なりを防止
  },
  tileImage: {
    width: 80,
    height: 80,
    borderRadius: 8,
    marginRight: 12,
  },
  placeholderImage: {
    backgroundColor: '#E5E5EA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: '#8E8E93',
    fontSize: 10,
  },
  tileInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  tileDate: {
    fontSize: 13,
    marginBottom: 2,
  },
  tileFavButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    padding: 6,
    zIndex: 10,
  },
  tileCategory: {
    fontSize: 17,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  tileDuration: {
    fontSize: 15,
  },
  tagBadge: {
    backgroundColor: '#E5E5EA',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginRight: 6,
    marginTop: 2,
  },
  tagBadgeText: {
    fontSize: 11,
    color: '#007AFF',
    fontWeight: '600',
  },
  favoriteTagBadge: {
    backgroundColor: '#FFF3D6',
    borderColor: '#FFD60A',
    borderWidth: 0.5,
  },
  favoriteTagBadgeText: {
    color: '#B27B00',
    fontWeight: '700',
  },

  // 空表示
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
    marginTop: 20,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 22,
  },
  resetFilterButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  resetFilterButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },

  // モーダル
  modalContainer: {
    flex: 1,
    padding: 20,
    marginTop: 40,
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  modalDetailImage: {
    width: '100%',
    height: 300,
    borderRadius: 12,
    marginBottom: 20,
  },
  modalInfoBox: {
    padding: 15,
    borderRadius: 12,
    marginBottom: 24,
  },
  infoText: {
    fontSize: 17,
    marginBottom: 8,
  },
  modalFavBadge: {
    backgroundColor: '#FFF3D6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 0.5,
    borderColor: '#FFB800',
  },
  modalFavBadgeText: {
    color: '#B27B00',
    fontSize: 12,
    fontWeight: 'bold',
  },
  modalActionButtons: {
    marginBottom: 20,
  },
  actionButton: {
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    flexDirection: 'row',
  },
  actionButtonFav: {
    backgroundColor: '#F2F2F7',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  actionButtonFavActive: {
    backgroundColor: '#FF9500',
  },
  closeButton: {
    backgroundColor: '#8E8E93',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },

  // 表示モード切替セグメントコントロール（鮮やかなソリッドブルー仕様）
  viewModeContainer: {
    flexDirection: 'row',
    marginHorizontal: 0,
    marginBottom: 8,
    padding: 4,
    borderRadius: 11,
    borderWidth: 1,
  },
  viewModeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 8,
  },
  viewModeBtnActiveNormal: {
    backgroundColor: '#007AFF',
    shadowColor: '#007AFF',
    shadowOpacity: 0.35,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  viewModeBtnActiveEco: {
    backgroundColor: '#0055B3',
    borderWidth: 1,
    borderColor: '#64D2FF',
  },
  viewModeBtnText: {
    fontSize: 13.5,
    fontWeight: '600',
  },
  viewModeBtnTextActiveNormal: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  viewModeBtnTextActiveEco: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  viewModeCountBadge: {
    marginLeft: 6,
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderRadius: 10,
  },
  viewModeCountBadgeActiveNormal: {
    backgroundColor: 'rgba(255, 255, 255, 0.28)',
  },
  viewModeCountBadgeActiveEco: {
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
  },
  viewModeCountBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  viewModeCountBadgeTextActiveNormal: {
    color: '#FFFFFF',
  },
  viewModeCountBadgeTextActiveEco: {
    color: '#FFFFFF',
  },

  // ギャラリー用オーバーレイトグル
  overlayToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#007AFF',
    backgroundColor: '#F0F8FF',
  },
  overlayToggleBtnActive: {
    backgroundColor: '#E0F0FF',
    borderColor: '#007AFF',
  },
  overlayToggleBtnEco: {
    backgroundColor: '#1C1C1E',
    borderColor: '#333',
  },
  overlayToggleBtnActiveEco: {
    backgroundColor: '#162534',
    borderColor: '#64D2FF',
  },
  overlayToggleBtnText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#007AFF',
  },
  overlayToggleBtnTextActive: {
    color: '#007AFF',
    fontWeight: '700',
  },
  overlayToggleBtnTextActiveEco: {
    color: '#64D2FF',
    fontWeight: '700',
  },

  // ギャラリーグリッド
  galleryRow: {
    paddingHorizontal: 0,
    justifyContent: 'flex-start',
    gap: 8,
    marginBottom: 8,
  },
  galleryTileWrapper: {
    borderRadius: 12,
  },
  galleryTile: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  galleryMainPressable: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  galleryImage: {
    width: '100%',
    height: '100%',
  },
  galleryTopLeft: {
    position: 'absolute',
    top: 6,
    left: 6,
    maxWidth: '68%',
  },
  galleryTopRight: {
    position: 'absolute',
    top: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  galleryMultiPhotoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    paddingVertical: 2.5,
    borderRadius: 6,
  },
  galleryMultiPhotoText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
  galleryCountBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: 6,
  },
  galleryCountBadgeText: {
    color: '#FFFFFF',
    fontSize: 10.5,
    fontWeight: '700',
  },
  galleryFavButton: {
    padding: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  galleryBottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingVertical: 4,
    paddingHorizontal: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  galleryTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  galleryTimeText: {
    color: '#FFFFFF',
    fontSize: 10.5,
    fontWeight: '700',
  },
  galleryDateText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 10,
    fontWeight: '600',
  },
});
