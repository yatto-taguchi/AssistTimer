import AsyncStorage from '@react-native-async-storage/async-storage';

const RECORDS_KEY = 'ASSISTIMER_RECORDS';

// 記録の保存
export const saveRecord = async (record) => {
  try {
    const existingRecords = await getRecords();
    // record = { id, date, duration, category, photoUri, ... }
    const newRecord = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      ...record
    };
    const updatedRecords = [newRecord, ...existingRecords];
    await AsyncStorage.setItem(RECORDS_KEY, JSON.stringify(updatedRecords));
    return updatedRecords;
  } catch (e) {
    console.error("Failed to save record", e);
    return [];
  }
};

// 全記録の取得
export const getRecords = async () => {
  try {
    const jsonValue = await AsyncStorage.getItem(RECORDS_KEY);
    return jsonValue != null ? JSON.parse(jsonValue) : [];
  } catch (e) {
    console.error("Failed to load records", e);
    return [];
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

// 練習回数（合計回数）の取得用ヘルパー
export const getTotalPracticeCount = async () => {
    const records = await getRecords();
    return records.length;
};
