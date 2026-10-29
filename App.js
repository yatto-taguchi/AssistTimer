import React, { useContext, useEffect, useRef } from 'react';
import { Animated, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme, createNavigationContainerRef } from '@react-navigation/native';
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
const navigationRef = createNavigationContainerRef();

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
          lazy: false, // ★ 起動時にHomeScreenとSalonWorkScreenの両方を確実にマウントし、Watch双方向同期を常時稼働
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

function GlobalPeerToastOverlay() {
  const { globalPeerToast, hideGlobalPeerToast, isEcoMode } = useContext(AppContext);
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(-90)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (globalPeerToast) {
      translateY.setValue(-28);
      opacity.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          damping: 18,
          stiffness: 220,
          mass: 0.8,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [globalPeerToast?.id, globalPeerToast?.timestamp]);

  if (!globalPeerToast) return null;

  const accentColor = globalPeerToast.color || '#30D158';
  const currentRouteName = navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : null;
  const isOutsideSalonTab = currentRouteName && currentRouteName !== 'Salon';

  const handlePressToast = () => {
    if (navigationRef.isReady() && navigationRef.getCurrentRoute()?.name !== 'Salon') {
      navigationRef.navigate('Salon');
    }
    hideGlobalPeerToast();
  };

  return (
    <View
      pointerEvents="box-none"
      style={[
        toastStyles.overlayContainer,
        { top: Math.max((insets?.top || 0) + 8, 16) },
      ]}
    >
      <Animated.View
        style={[
          toastStyles.toastCard,
          {
            backgroundColor: isEcoMode ? '#1C1C1E' : accentColor,
            borderColor: isEcoMode ? accentColor : 'rgba(255,255,255,0.28)',
            borderWidth: isEcoMode ? 1.5 : 1,
            transform: [{ translateY }],
            opacity,
          },
        ]}
      >
        <TouchableOpacity
          activeOpacity={0.88}
          onPress={handlePressToast}
          style={toastStyles.toastMainTouch}
        >
          <View
            style={[
              toastStyles.accentDot,
              { backgroundColor: isEcoMode ? accentColor : '#FFFFFF' },
            ]}
          />
          <View style={toastStyles.textColumn}>
            <Text style={toastStyles.toastTitle} numberOfLines={1}>
              サロン共有通知{isOutsideSalonTab ? '（タップでサロンへ）' : ''}
            </Text>
            <Text style={toastStyles.toastBody} numberOfLines={2}>
              {globalPeerToast.text}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={hideGlobalPeerToast}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={toastStyles.closeButton}
        >
          <Ionicons name="close-circle" size={20} color="rgba(255,255,255,0.88)" />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const toastStyles = StyleSheet.create({
  overlayContainer: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 9999,
    elevation: 9999,
    alignItems: 'center',
  },
  toastCard: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 14,
    paddingVertical: 11,
    paddingLeft: 13,
    paddingRight: 10,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.32,
    shadowRadius: 8,
    elevation: 10,
  },
  toastMainTouch: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  accentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  textColumn: {
    flex: 1,
  },
  toastTitle: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 10.5,
    fontWeight: '700',
    marginBottom: 2,
  },
  toastBody: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '800',
    lineHeight: 18,
  },
  closeButton: {
    marginLeft: 8,
    padding: 2,
  },
});

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
    <View style={{ flex: 1 }}>
      <NavigationContainer ref={navigationRef} theme={navTheme}>
        <MainTabs />
      </NavigationContainer>
      <GlobalPeerToastOverlay />
    </View>
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
