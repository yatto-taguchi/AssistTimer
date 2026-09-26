import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'react-native';

const RECORDS_KEY = 'ASSISTIMER_RECORDS';

// デモ用画像URIの取得
const cutUri = Image.resolveAssetSource(require('../../assets/demo/cut.jpg')).uri;
const windingUri = Image.resolveAssetSource(require('../../assets/demo/winding.jpg')).uri;
const colorUri = Image.resolveAssetSource(require('../../assets/demo/color.jpg')).uri;
const updoUri = Image.resolveAssetSource(require('../../assets/demo/updo.jpg')).uri;

// デモ用サンプルデータ
export const DEMO_RECORDS = [
  {
    id: 'demo-1',
    date: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2時間前
    duration: 1200, // 20分00秒
    category: 'カット',
    photoUris: [cutUri],
    photoUri: cutUri,
    tags: ['お気に入り', 'タイム'],
    isFavorite: true,
    memo: 'ワンレングスカットの練習。タイム内におさまりラインも綺麗に出せた。'
  },
  {
    id: 'demo-2',
    date: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(), // 1日前
    duration: 1725, // 28分45秒
    category: 'ワインディング',
    photoUris: [windingUri],
    photoUri: windingUri,
    tags: ['タイム'],
    isFavorite: false,
    memo: 'センターロッド巻きスピード意識。ゴム掛けのテンション安定してきた。'
  },
  {
    id: 'demo-3',
    date: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(), // 2日前
    duration: 930, // 15分30秒
    category: 'カラー',
    photoUris: [colorUri],
    photoUri: colorUri,
    tags: ['お気に入り'],
    isFavorite: true,
    memo: 'リタッチ塗布練習。コーミングの手数を減らして時短できた。'
  },
  {
    id: 'demo-4',
    date: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(), // 3日前
    duration: 2110, // 35分10秒
    category: 'アップスタイル',
    photoUris: [updoUri],
    photoUri: updoUri,
    tags: [],
    isFavorite: false,
    memo: '夜会巻きのベース作りとピン打ちの練習。'
  }
];

// 記録の保存
export const saveRecord = async (record) => {
  try {
    const existingRecords = await getRecords();
    const isFav = record.isFavorite === true || (Array.isArray(record.tags) && record.tags.includes('お気に入り'));
    let tags = Array.isArray(record.tags) ? [...record.tags] : [];
    if (isFav && !tags.includes('お気に入り')) {
      tags.push('お気に入り');
    }
    // record = { id, date, duration, category, photoUri, ... }
    const newRecord = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      ...record,
      isFavorite: isFav,
      tags: tags,
    };
    const updatedRecords = [newRecord, ...existingRecords];
    await AsyncStorage.setItem(RECORDS_KEY, JSON.stringify(updatedRecords));
    return updatedRecords;
  } catch (e) {
    console.error("Failed to save record", e);
    return [];
  }
};

// 全記録の取得（デモデータが含まれていて写真がない場合は写真を補完して保存）
export const getRecords = async () => {
  try {
    const jsonValue = await AsyncStorage.getItem(RECORDS_KEY);
    if (jsonValue !== null) {
      const records = JSON.parse(jsonValue);
      // デモデータの写真が未設定の場合は写真付きにアップデート
      let hasUpdates = false;
      const enrichedRecords = records.map(r => {
        let updated = { ...r };
        // isFavoriteの補完
        if (updated.isFavorite === undefined) {
          updated.isFavorite = Array.isArray(updated.tags) && updated.tags.includes('お気に入り');
          hasUpdates = true;
        }
        if (r.id === 'demo-1' && (!r.photoUris || r.photoUris.length === 0)) {
          hasUpdates = true;
          updated = { ...updated, photoUris: [cutUri], photoUri: cutUri };
        }
        if (r.id === 'demo-2' && (!r.photoUris || r.photoUris.length === 0)) {
          hasUpdates = true;
          updated = { ...updated, photoUris: [windingUri], photoUri: windingUri };
        }
        if (r.id === 'demo-3' && (!r.photoUris || r.photoUris.length === 0)) {
          hasUpdates = true;
          updated = { ...updated, photoUris: [colorUri], photoUri: colorUri };
        }
        if (r.id === 'demo-4' && (!r.photoUris || r.photoUris.length === 0)) {
          hasUpdates = true;
          updated = { ...updated, photoUris: [updoUri], photoUri: updoUri };
        }
        return updated;
      });
      if (hasUpdates) {
        await AsyncStorage.setItem(RECORDS_KEY, JSON.stringify(enrichedRecords));
      }
      return enrichedRecords;
    } else {
      // 初回起動時など空の場合はデモデータをセット
      await AsyncStorage.setItem(RECORDS_KEY, JSON.stringify(DEMO_RECORDS));
      return DEMO_RECORDS;
    }
  } catch (e) {
    console.error("Failed to load records", e);
    return DEMO_RECORDS;
  }
};

// 特定の記録の写真（や他項目）を更新する
export const updateRecordPhoto = async (recordId, newPhotoUri) => {
    try {
        const records = await getRecords();
        const updatedRecords = records.map(record => {
            if (record.id === recordId) {
                return { ...record, photoUri: newPhotoUri };
            }
            return record;
        });
        await AsyncStorage.setItem(RECORDS_KEY, JSON.stringify(updatedRecords));
        return updatedRecords;
    } catch (e) {
        console.error("Failed to update record", e);
        return [];
    }
};

// 特定の記録のお気に入り状態をトグルする
export const toggleRecordFavorite = async (recordId) => {
    try {
        const records = await getRecords();
        const updatedRecords = records.map(record => {
            if (record.id === recordId) {
                const currentFav = record.isFavorite === true || (Array.isArray(record.tags) && record.tags.includes('お気に入り'));
                const newFav = !currentFav;
                let newTags = Array.isArray(record.tags) ? [...record.tags] : [];
                if (newFav) {
                    if (!newTags.includes('お気に入り')) newTags.push('お気に入り');
                } else {
                    newTags = newTags.filter(t => t !== 'お気に入り');
                }
                return {
                    ...record,
                    isFavorite: newFav,
                    tags: newTags,
                };
            }
            return record;
        });
        await AsyncStorage.setItem(RECORDS_KEY, JSON.stringify(updatedRecords));
        return updatedRecords;
    } catch (e) {
        console.error("Failed to toggle favorite", e);
        return [];
    }
};

// 練習回数（合計回数）の取得用ヘルパー
export const getTotalPracticeCount = async () => {
    const records = await getRecords();
    return records.length;
};

/**
 * 記録日時を YYYY/MM/DD HH:mm 形式（ローカル時刻）にフォーマット
 * @param {string|Date} dateValue - 日時文字列またはDateオブジェクト
 * @returns {string} フォーマットされた日時文字列（例: "2026/09/26 13:46"）
 */
export const formatRecordDateTime = (dateValue) => {
  if (!dateValue) return '';
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
};

/**
 * 記録日時を M/D HH:mm 形式（写真アルバム用・コンパクト）にフォーマット
 * @param {string|Date} dateValue - 日時文字列またはDateオブジェクト
 * @returns {string} フォーマットされた日時文字列（例: "9/26 13:46"）
 */
export const formatCompactDateTime = (dateValue) => {
  if (!dateValue) return '';
  const d = new Date(dateValue);
  if (isNaN(d.getTime())) return '';
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
};

