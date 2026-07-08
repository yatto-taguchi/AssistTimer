import React, { useContext } from 'react';
import { StyleSheet, Text, View, Switch } from 'react-native';
import { AppContext } from '../utils/AppContext';

export default function SettingsScreen() {
  const { isEcoMode, toggleEcoMode, isProMode, toggleProMode } = useContext(AppContext);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>設定</Text>
      
      <View style={styles.settingRow}>
        <Text style={styles.settingText}>エコモード（省電力・黒背景）</Text>
        <Switch
          value={isEcoMode}
          onValueChange={toggleEcoMode}
        />
      </View>

      <View style={styles.settingRow}>
        <Text style={styles.settingText}>Proモード（広告非表示デモ）</Text>
        <Switch
          value={isProMode}
          onValueChange={toggleProMode}
        />
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 20,
    justifyContent: 'flex-start',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 30,
    marginTop: 20,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5EA',
  },
  settingText: {
    fontSize: 18,
  },
});
