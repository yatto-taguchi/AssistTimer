import React, { useContext } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';

import { AppProvider, AppContext } from './src/utils/AppContext';

import HomeScreen from './src/screens/HomeScreen';
import RecordsScreen from './src/screens/RecordsScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import CustomBatteryIndicator from './src/components/CustomBatteryIndicator';

const Tab = createBottomTabNavigator();

function MainTabs() {
  const { isEcoMode, isEcoNavIconEnabled, isEcoNavActiveDot, isEcoBorderEnabled } = useContext(AppContext);

  return (
    <>
      <StatusBar hidden={isEcoMode} style={isEcoMode ? "light" : "auto"} />
      <CustomBatteryIndicator />
      <Tab.Navigator
        initialRouteName="Home"
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: isEcoMode ? '#888' : '#007AFF', // 選択中を明るいグレーに
          tabBarInactiveTintColor: isEcoMode ? '#333' : '#8E8E93', // 非選択中もうっすら見えるように
          tabBarShowLabel: !isEcoMode,
          tabBarStyle: {
            backgroundColor: isEcoMode ? '#000' : '#fff',
            borderTopWidth: isEcoMode && !isEcoBorderEnabled ? 0 : undefined,
            borderBottomWidth: isEcoMode && !isEcoBorderEnabled ? 0 : undefined,
            elevation: isEcoMode && !isEcoBorderEnabled ? 0 : undefined, // Androidの影を消す
            shadowOpacity: isEcoMode && !isEcoBorderEnabled ? 0 : undefined, // iOSの影を消す
          },
          tabBarPosition: 'top',
          tabBarIcon: ({ focused, color, size }) => {
            // アイコン表示がOFFの時（点モード）
            if (isEcoMode && !isEcoNavIconEnabled) {
              if (isEcoNavActiveDot) {
                // 選択中タブのみ点にする機能がON：選択中だけ点を表示し、他は非表示（真っ黒）
                return focused ? <Ionicons name="ellipse" size={8} color={color} /> : null;
              } else {
                // 全てのタブに点を表示
                return <Ionicons name="ellipse" size={8} color={color} />;
              }
            }

            let iconName;

            if (route.name === 'Records') {
              iconName = focused ? 'book' : 'book-outline';
            } else if (route.name === 'Home') {
              iconName = focused ? 'time' : 'time-outline';
            } else if (route.name === 'Settings') {
              iconName = focused ? 'settings' : 'settings-outline';
            }

            return <Ionicons name={iconName} size={size || 24} color={color} />;
          },
        })}
      >
      <Tab.Screen 
        name="Records" 
        component={RecordsScreen} 
        options={{ title: '記録一覧' }}
      />
      <Tab.Screen 
        name="Home" 
        component={HomeScreen} 
        options={{ title: 'タイマー' }}
      />
      <Tab.Screen 
        name="Settings" 
        component={SettingsScreen} 
        options={{ title: '設定' }}
      />
    </Tab.Navigator>
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <NavigationContainer>
        <MainTabs />
      </NavigationContainer>
    </AppProvider>
  );
}
