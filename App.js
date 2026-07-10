import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

import { AppProvider } from './src/utils/AppContext';

import HomeScreen from './src/screens/HomeScreen';
import RecordsScreen from './src/screens/RecordsScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <AppProvider>
      <NavigationContainer>
        <Tab.Navigator
          initialRouteName="Home"
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarActiveTintColor: '#007AFF',
            tabBarPosition: 'top',
            tabBarIcon: ({ focused, color, size }) => {
              let iconName;

              if (route.name === 'Records') {
                iconName = focused ? 'book' : 'book-outline';
              } else if (route.name === 'Home') {
                iconName = focused ? 'time' : 'time-outline';
              } else if (route.name === 'Settings') {
                iconName = focused ? 'settings' : 'settings-outline';
              }

              // デフォルトのサイズだと上部タブでは少し大きく見える場合があるので適宜調整
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
      </NavigationContainer>
    </AppProvider>
  );
}
