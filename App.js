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
  const { isEcoMode, isEcoNavDotMode } = useContext(AppContext);

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
            borderTopWidth: 0,
          },
          tabBarPosition: 'top',
          tabBarIcon: ({ focused, color, size }) => {
            if (isEcoMode && isEcoNavDotMode) {
              return <Ionicons name="ellipse" size={8} color={color} />;
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
