import React, { useContext } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator, BottomTabBar } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';

import { AppProvider, AppContext } from './src/utils/AppContext';

import HomeScreen from './src/screens/HomeScreen';
import RecordsScreen from './src/screens/RecordsScreen';
import SalonWorkScreen from './src/screens/SalonWorkScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import CustomBatteryIndicator from './src/components/CustomBatteryIndicator';

const Tab = createBottomTabNavigator();

function MainTabs() {
  const { 
    isEcoMode, 
    isEcoNavIconEnabled, 
    isEcoNavActiveDot, 
    isEcoBorderEnabled,
    isNormalStatusBarEnabled,
    isNormalStatusBarAutoHide,
    controlsOpacity,
    controlsVisible
  } = useContext(AppContext);

  // ステータスバーの非表示判定:
  // エコモード時は常に非表示
  // 通常モード時は、ステータスバー無効時または「自動で消す」有効かつUIフェードアウト時にスッと非表示
  const isStatusBarHidden = isEcoMode 
    ? true 
    : (!isNormalStatusBarEnabled || (isNormalStatusBarAutoHide && !controlsVisible));

  const appBgColor = isEcoMode ? '#000000' : '#F5F5F5';

  return (
    <View style={{ flex: 1, backgroundColor: appBgColor }}>
      <StatusBar 
        hidden={isStatusBarHidden} 
        animated={true} 
        hideTransitionAnimation="fade" 
        style={isEcoMode ? "light" : "auto"} 
      />
      <CustomBatteryIndicator />
      <Tab.Navigator
        initialRouteName="Home"
        sceneContainerStyle={{ backgroundColor: appBgColor }}
        tabBar={(props) => (
          <Animated.View
            style={{ 
              opacity: controlsOpacity,
              backgroundColor: isEcoMode ? '#000000' : '#FFFFFF'
            }}
            pointerEvents={controlsVisible ? 'auto' : 'none'}
          >
            <BottomTabBar {...props} />
          </Animated.View>
        )}
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: isEcoMode ? '#888' : '#007AFF', // 選択中を明るいグレーに
          tabBarInactiveTintColor: isEcoMode ? '#333' : '#8E8E93', // 非選択中もうっすら見えるように
          tabBarShowLabel: !isEcoMode,
          tabBarAllowFontScaling: false, // OSの文字サイズ拡大による枠外はみ出し・切断を防止
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '600',
            marginTop: -2,
            marginBottom: 2,
          },
          tabBarStyle: {
            backgroundColor: isEcoMode ? '#000' : '#fff',
            borderTopWidth: 0,
            borderBottomWidth: isEcoMode && !isEcoBorderEnabled ? 0 : StyleSheet.hairlineWidth,
            borderBottomColor: isEcoMode ? '#2C2C2E' : '#E5E5EA',
            elevation: isEcoMode && !isEcoBorderEnabled ? 0 : undefined, // Androidの影を消す
            shadowOpacity: isEcoMode && !isEcoBorderEnabled ? 0 : undefined, // iOSの影を消す
            paddingBottom: isEcoMode ? 0 : 2,
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
            } else if (route.name === 'Salon') {
              iconName = focused ? 'people' : 'people-outline';
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
        options={{ title: 'タイマー', lazy: false }}
      />
      <Tab.Screen 
        name="Salon" 
        component={SalonWorkScreen} 
        options={{ title: 'サロン', lazy: false }}
      />
      <Tab.Screen 
        name="Settings" 
        component={SettingsScreen} 
        options={{ title: '設定' }}
      />
    </Tab.Navigator>
    </View>
  );
}

function AppContent() {
  const { isEcoMode } = useContext(AppContext);
  const baseTheme = isEcoMode ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      background: isEcoMode ? '#000000' : '#F5F5F5',
      card: isEcoMode ? '#000000' : '#FFFFFF',
    },
  };

  return (
    <NavigationContainer theme={navTheme}>
      <MainTabs />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </SafeAreaProvider>
  );
}
