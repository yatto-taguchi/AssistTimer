import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

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
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: '#007AFF',
            tabBarPosition: 'top',
          }}
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
